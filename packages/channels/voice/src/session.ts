/**
 * The live call (v0.9.1) — a real voice conversation with GUS,
 * not a sequence of recordings.
 *
 * Shape: ONE session at a time, bound to the same "voice"
 * conversation the push-to-talk call used. The app streams raw
 * PCM chunks while the operator is in the call; an energy VAD
 * (vad.ts) cuts the stream into utterances on trailing silence;
 * each utterance takes the IDENTICAL turn the 0.9.0 call took
 * (VoiceCallService.processTranscript — secret-guard, Shield
 * scan, classifier, caps, receipts, the parked-approval
 * read-back and its exact-phrase rule, the kill phrase) and the
 * reply is spoken back sentence by sentence (sentences.ts), so
 * the first words are audible while the rest is still being
 * synthesized. Turns are processed serially — a call is a
 * conversation, not a fan-out.
 *
 * Barge-in: the app hears the operator talk over playback, stops
 * its player, and calls interrupt(). Here, interrupt bumps the
 * speech generation, aborts the in-flight synthesis, and drops
 * every unfetched audio segment — the REST of the reply is never
 * spoken. It touches nothing else: a job already running keeps
 * running (only its narration stops), no /stop is submitted, no
 * approval state moves. The hard stops are unchanged: the kill
 * phrase, End Call, the idle timeout (3 minutes of silence while
 * nothing is being said or done), and the maximum session
 * length (60 minutes) — each ending is recorded in the session
 * state with its reason, where the app's transcript shows it.
 *
 * Latency: every turn records its stage timings (utterance end →
 * transcript → reply → first spoken sentence) in its turn record
 * and in the session's lastLatency. This is the data the
 * local-vs-cloud speech decision gets made from, so it is
 * measured here, where the stages actually happen — and reported
 * nowhere else.
 *
 * The microphone's liveness is the app's side of the contract:
 * this service only ever sees audio the app chose to stream, and
 * only while a session the operator started is active. There is
 * no listen-outside-a-call path in this package.
 */
import {
  loadVoiceConfig,
  voiceConfigured,
  type VoiceConfig,
} from "./config.js";
import {
  synthesize,
  transcribe,
  SpeechServiceError,
  type FetchFn,
} from "./speech.js";
import {
  VoiceCallService,
  type PendingApprovalLookup,
  type VoiceAdapter,
} from "./voice-channel.js";
import {
  UtteranceSegmenter,
  wrapPcm16AsWav,
} from "./vad.js";
import { splitSentences } from "./sentences.js";

export interface VoiceTurnLatency {
  /** When the utterance's speech ended (the silence began). */
  utteranceEndAt: number;
  /** Utterance end → transcript in hand. */
  sttMs: number;
  /** Transcript → the host's reply (scan, job, settlement). */
  jobMs: number;
  /** Reply in hand → first sentence's audio ready to play. */
  ttsFirstMs?: number;
  /** Utterance end → first audio (or → turn settled, if the
   *  turn produced no speech). */
  totalMs: number;
}

export interface VoiceSessionTurn {
  index: number;
  startedAt: number;
  transcript?: string;
  /** The VoiceCallResult kind, verbatim (reply | pending |
   *  stopped | approval-resolved | awaiting-confirmation |
   *  unavailable). */
  kind: string;
  detail: string;
  replyText?: string;
  /** The operator talked over this reply and its speech was
   *  cut — the job behind it was NOT cancelled. */
  interrupted: boolean;
  latency?: VoiceTurnLatency;
}

export type VoiceSessionEndReason =
  | "operator"
  | "idle-timeout"
  | "max-length"
  | "kill-phrase"
  | "disabled";

export type VoiceSessionPhase = "listening" | "thinking" | "speaking" | "ended";

export interface VoiceSessionStateData {
  ok: boolean;
  detail: string;
  active: boolean;
  sessionId?: string;
  phase?: VoiceSessionPhase;
  startedAt?: number;
  elapsedMs?: number;
  endedReason?: VoiceSessionEndReason;
  bargeIn?: boolean;
  turns: VoiceSessionTurn[];
  lastLatency?: VoiceTurnLatency;
}

export interface VoiceAudioSegmentData {
  ok: boolean;
  detail: string;
  seq?: number;
  turnIndex?: number;
  sentenceIndex?: number;
  audioBase64?: string;
  audioContentType?: string;
}

interface AudioSegment {
  seq: number;
  turnIndex: number;
  sentenceIndex: number;
  audioBase64: string;
  audioContentType: string;
  fetched: boolean;
}

interface ActiveSession {
  id: string;
  startedAt: number;
  lastSpeechAt: number;
  segmenter: UtteranceSegmenter;
  turns: VoiceSessionTurn[];
  segments: AudioSegment[];
  nextSeq: number;
  /** Bumped by interrupt AND by each new turn's speech: a
   *  streamer only speaks while its generation is current. */
  speechGen: number;
  speechAbort?: AbortController;
  speakingTurn?: number;
  streaming: boolean;
  processing: boolean;
  chain: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  lastLatency?: VoiceTurnLatency;
}

const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_SESSION_MS = 3_600_000;

export class VoiceSessionService {
  private fetchFn: FetchFn;
  private now: () => number;
  private idleTimeoutMs: number;
  private maxSessionMs: number;
  private silenceMs?: number;
  private vadThreshold?: number;
  private calls: VoiceCallService;
  private session?: ActiveSession;
  /** The last ended session's state, kept so the app's poll can
   *  learn WHY the call ended (timeout, kill phrase) instead of
   *  the session simply vanishing. Replaced by the next start. */
  private endedSnapshot?: VoiceSessionStateData;
  private counter = 0;

  constructor(
    private stateDir: string,
    adapter: VoiceAdapter,
    approvals: PendingApprovalLookup,
    opts?: {
      fetchFn?: FetchFn;
      replyTimeoutMs?: number;
      now?: () => number;
      idleTimeoutMs?: number;
      maxSessionMs?: number;
      silenceMs?: number;
      vadThreshold?: number;
    },
  ) {
    this.fetchFn = opts?.fetchFn ?? fetch;
    this.now = opts?.now ?? (() => Date.now());
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessionMs = opts?.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
    this.silenceMs = opts?.silenceMs;
    this.vadThreshold = opts?.vadThreshold;
    this.calls = new VoiceCallService(stateDir, adapter, approvals, {
      fetchFn: this.fetchFn,
      replyTimeoutMs: opts?.replyTimeoutMs,
    });
  }

  // ------------------------------------------------------------ lifecycle

  /** Open a call. The guards are the 0.9.0 call's guards, word
   *  for word: voice off or unconfigured refuses loudly, before
   *  any audio is accepted. One call at a time — a second start
   *  while one is live answers with the live session's state. */
  start(): VoiceSessionStateData {
    if (this.session) {
      return {
        ...this.state(this.session.id),
        ok: false,
        detail: "A call is already in progress — end it before starting another.",
      };
    }
    const config = loadVoiceConfig(this.stateDir);
    if (!config.enabled) {
      return {
        ok: false,
        active: false,
        turns: [],
        detail:
          "Voice is off. Enable it in Settings → Voice and point it at your transcription and speech services, then try again. Nothing was sent to GUS.",
      };
    }
    if (!voiceConfigured(config)) {
      return {
        ok: false,
        active: false,
        turns: [],
        detail:
          "Voice is enabled but an endpoint is missing from its settings. Nothing was sent to GUS — check Settings → Voice.",
      };
    }
    const now = this.now();
    const session: ActiveSession = {
      id: `call-${now.toString(36)}-${this.counter++}`,
      startedAt: now,
      lastSpeechAt: now,
      segmenter: new UtteranceSegmenter({
        silenceMs: this.silenceMs,
        threshold: this.vadThreshold,
      }),
      turns: [],
      segments: [],
      nextSeq: 1,
      speechGen: 0,
      streaming: false,
      processing: false,
      chain: Promise.resolve(),
    };
    this.session = session;
    this.endedSnapshot = undefined;
    // The timeouts also run on a clock, not only when audio or a
    // poll happens to arrive — a call the operator walked away
    // from must still end. unref'd: a call never keeps the
    // control plane alive by itself.
    session.timer = setInterval(() => this.tick(), 1_000);
    session.timer.unref?.();
    return {
      ...this.state(session.id),
      detail:
        "Call started. Speak naturally — a pause ends your turn. Talking over a reply cuts it off; \"GUS stop\" ends the call and trips the kill switch.",
    };
  }

  /** End the call from the operator's side (the End Call
   *  button). A partial utterance in flight is dropped, the way
   *  hanging up drops a half-spoken sentence. */
  end(sessionId: string): VoiceSessionStateData {
    const session = this.session;
    if (!session || session.id !== sessionId) {
      return {
        ok: false,
        active: false,
        turns: this.endedSnapshot?.turns ?? [],
        detail: "No live call by that id — it may already have ended.",
      };
    }
    return this.finish(session, "operator");
  }

  // ------------------------------------------------------------ audio in

  /**
   * One streamed chunk of mic audio (raw PCM16, 16 kHz mono).
   * Speech energy moves the idle clock; a completed utterance is
   * queued onto the session's serial turn chain. Returns as soon
   * as the chunk is accepted — the turn itself settles in state.
   */
  pushAudio(sessionId: string, chunk: Uint8Array): { ok: boolean; detail: string } {
    const session = this.session;
    if (!session || session.id !== sessionId) {
      return { ok: false, detail: "No live call by that id — the audio was dropped, nothing was sent to GUS." };
    }
    this.tick();
    if (this.session !== session) {
      return { ok: false, detail: "The call ended (timeout) as that audio arrived — it was dropped." };
    }
    if (chunk.length === 0) return { ok: true, detail: "Empty chunk ignored." };
    const pushed = session.segmenter.push(chunk, this.now());
    if (pushed.speech) session.lastSpeechAt = this.now();
    if (pushed.utterance) {
      const utterance = pushed.utterance;
      const endMs = pushed.utteranceEndMs ?? this.now();
      session.chain = session.chain.then(() => this.runUtterance(session, utterance, endMs));
    }
    return { ok: true, detail: "Heard." };
  }

  // ------------------------------------------------------------ speech out

  /** The next spoken segment after `afterSeq`, in order — the
   *  app's playback queue polls this and plays what it gets.
   *  Fetching marks the segment fetched: fetched audio is the
   *  app's to finish (or cut) locally; UNfetched audio is what
   *  an interrupt can still take back. */
  nextAudio(sessionId: string, afterSeq: number): VoiceAudioSegmentData {
    const session = this.session;
    if (!session || session.id !== sessionId) {
      return { ok: false, detail: "No live call by that id." };
    }
    const seg = session.segments.find((s) => s.seq > afterSeq);
    if (!seg) return { ok: true, detail: "Nothing to say right now." };
    seg.fetched = true;
    return {
      ok: true,
      detail: "Segment ready.",
      seq: seg.seq,
      turnIndex: seg.turnIndex,
      sentenceIndex: seg.sentenceIndex,
      audioBase64: seg.audioBase64,
      audioContentType: seg.audioContentType,
    };
  }

  /**
   * Barge-in: cut the current reply's speech. Cancels pending
   * synthesis (generation bump + abort) and drops every unfetched
   * segment; the speaking turn is marked interrupted in the
   * record. Deliberately NOT a stop: a running job keeps
   * running, a parked approval keeps waiting — only the talking
   * stops. A no-op (but still ok) when nothing is speaking.
   */
  interrupt(sessionId: string): { ok: boolean; detail: string } {
    const session = this.session;
    if (!session || session.id !== sessionId) {
      return { ok: false, detail: "No live call by that id." };
    }
    const config = loadVoiceConfig(this.stateDir);
    if (!config.bargeIn) {
      return { ok: true, detail: "Barge-in is off in Settings → Voice — the reply was left speaking." };
    }
    this.cutSpeech(session, "the operator talked over it");
    return { ok: true, detail: "Speech cut — the reply's remaining sentences were dropped unsaid. Nothing else was stopped." };
  }

  // ------------------------------------------------------------ state

  /** The session state the app polls: phase, the transcript so
   *  far (both sides, from the turn records), the last turn's
   *  latency, and — after an ending — the reason. An unknown id
   *  answers with the ended snapshot when it matches, else an
   *  honest inactive. */
  state(sessionId: string): VoiceSessionStateData {
    const session = this.session;
    if (session && session.id === sessionId) {
      const now = this.now();
      return {
        ok: true,
        detail: "Call in progress.",
        active: true,
        sessionId: session.id,
        phase: this.phase(session),
        startedAt: session.startedAt,
        elapsedMs: now - session.startedAt,
        bargeIn: loadVoiceConfig(this.stateDir).bargeIn,
        turns: session.turns,
        lastLatency: session.lastLatency,
      };
    }
    if (this.endedSnapshot && this.endedSnapshot.sessionId === sessionId) {
      return this.endedSnapshot;
    }
    return { ok: false, active: false, turns: [], detail: "No call by that id." };
  }

  /** Test + lifecycle helper: resolves when every queued turn
   *  has settled. The panel never calls this; tests do. */
  async drain(): Promise<void> {
    await this.session?.chain;
  }

  // ------------------------------------------------------------ timeouts

  /** Enforce the idle and max-length limits against the clock.
   *  Called by the session's interval, by pushAudio, and (with
   *  an injected clock) by tests. Idle means silence while the
   *  call is otherwise quiet — a call where GUS is mid-job or
   *  mid-reply is not idle, however long the operator listens. */
  tick(): void {
    const session = this.session;
    if (!session) return;
    const now = this.now();
    if (now - session.startedAt >= this.maxSessionMs) {
      this.finish(session, "max-length");
      return;
    }
    const busy =
      session.processing ||
      session.streaming ||
      session.segments.some((s) => !s.fetched);
    if (!busy && now - session.lastSpeechAt >= this.idleTimeoutMs) {
      this.finish(session, "idle-timeout");
    }
  }

  // ------------------------------------------------------------ turns

  private async runUtterance(session: ActiveSession, pcm: Uint8Array, utteranceEndAt: number): Promise<void> {
    if (this.session !== session) return;
    session.processing = true;
    const turn: VoiceSessionTurn = {
      index: session.turns.length,
      startedAt: this.now(),
      kind: "unavailable",
      detail: "",
      interrupted: false,
    };
    session.turns.push(turn);
    try {
      const config = loadVoiceConfig(this.stateDir);
      if (!config.enabled || !voiceConfigured(config)) {
        turn.detail =
          "Voice was turned off or unconfigured in Settings mid-call — the call ended and that utterance went nowhere.";
        this.finish(session, "disabled");
        return;
      }

      // --- ears ------------------------------------------------
      const sttStart = this.now();
      let transcript: string;
      try {
        transcript = await transcribe(
          this.fetchFn,
          { baseUrl: config.sttBaseUrl, model: config.sttModel },
          wrapPcm16AsWav(pcm),
          "audio/wav",
        );
      } catch (e) {
        turn.detail =
          e instanceof SpeechServiceError ? e.message : `Transcription failed: ${String(e)}`;
        return;
      }
      const sttMs = this.now() - sttStart;
      turn.transcript = transcript;

      // --- the turn: the same pipeline every voice surface uses.
      const jobStart = this.now();
      const result = await this.calls.processTranscript(transcript);
      const jobMs = this.now() - jobStart;
      turn.kind = result.kind;
      turn.detail = result.detail;
      turn.replyText = result.replyText;
      const latency: VoiceTurnLatency = {
        utteranceEndAt,
        sttMs,
        jobMs,
        totalMs: this.now() - utteranceEndAt,
      };
      turn.latency = latency;
      session.lastLatency = latency;

      // --- mouth: sentence by sentence, first one fast ---------
      if (result.replyText) {
        const ttsStart = this.now();
        await this.streamSpeech(session, turn, config, result.replyText, () => {
          latency.ttsFirstMs = this.now() - ttsStart;
          latency.totalMs = this.now() - utteranceEndAt;
        });
      }

      if (result.kind === "stopped") {
        // The kill phrase ran /stop through the normal path in
        // processTranscript; the call itself ends once the
        // confirmation has been spoken.
        this.finish(session, "kill-phrase");
      }
    } finally {
      session.processing = false;
    }
  }

  /**
   * Synthesize a reply sentence by sentence into the segment
   * queue. Starting a turn's speech supersedes any older turn's
   * unfetched speech (that reply is stale the moment the
   * operator has moved on — its turn is marked interrupted).
   * The generation check runs before AND after every synthesis:
   * an interrupt landing mid-call drops the segment it raced.
   */
  private async streamSpeech(
    session: ActiveSession,
    turn: VoiceSessionTurn,
    config: VoiceConfig,
    text: string,
    onFirstSegment: () => void,
  ): Promise<void> {
    const gen = ++session.speechGen;
    // Supersede older pending speech.
    for (const seg of session.segments) {
      if (!seg.fetched && seg.turnIndex !== turn.index) {
        const stale = session.turns[seg.turnIndex];
        if (stale) stale.interrupted = true;
      }
    }
    session.segments = session.segments.filter(
      (s) => s.fetched || s.turnIndex === turn.index,
    );
    const sentences = splitSentences(text);
    if (sentences.length === 0) return;
    const abort = new AbortController();
    session.speechAbort = abort;
    session.speakingTurn = turn.index;
    session.streaming = true;
    let first = true;
    try {
      for (let i = 0; i < sentences.length; i++) {
        if (gen !== session.speechGen || this.session !== session) {
          turn.interrupted = true;
          return;
        }
        let out: { audio: Uint8Array; contentType: string };
        try {
          out = await synthesize(
            this.fetchFn,
            { baseUrl: config.ttsBaseUrl, model: config.ttsModel, voice: config.ttsVoice },
            sentences[i],
            undefined,
            abort.signal,
          );
        } catch (e) {
          if (gen !== session.speechGen || this.session !== session) {
            turn.interrupted = true;
            return;
          }
          // Loud, in the record: the reply exists as text in the
          // transcript; the turn says exactly why it went unspoken.
          turn.detail =
            `${turn.detail} Speech failed mid-reply: ` +
            (e instanceof SpeechServiceError ? e.message : String(e));
          return;
        }
        if (gen !== session.speechGen || this.session !== session) {
          turn.interrupted = true;
          return;
        }
        session.segments.push({
          seq: session.nextSeq++,
          turnIndex: turn.index,
          sentenceIndex: i,
          audioBase64: Buffer.from(out.audio).toString("base64"),
          audioContentType: out.contentType,
          fetched: false,
        });
        if (first) {
          first = false;
          onFirstSegment();
        }
      }
    } finally {
      if (gen === session.speechGen) {
        session.streaming = false;
        session.speakingTurn = undefined;
        session.speechAbort = undefined;
      }
    }
  }

  /** The shared cut: generation bump (pending synthesis drops
   *  its result), abort (the service call itself is cancelled),
   *  unfetched segments dropped, the speaking turn marked. */
  private cutSpeech(session: ActiveSession, _why: string): void {
    session.speechGen++;
    session.speechAbort?.abort();
    const speaking = session.speakingTurn !== undefined
      ? session.turns[session.speakingTurn]
      : undefined;
    const hadPending = session.segments.some((s) => !s.fetched);
    session.segments = session.segments.filter((s) => s.fetched);
    if (speaking && (hadPending || session.streaming)) {
      speaking.interrupted = true;
    }
  }

  private phase(session: ActiveSession): VoiceSessionPhase {
    if (session.processing) return "thinking";
    if (session.streaming || session.segments.some((s) => !s.fetched)) return "speaking";
    return "listening";
  }

  private finish(session: ActiveSession, reason: VoiceSessionEndReason): VoiceSessionStateData {
    if (session.timer) clearInterval(session.timer);
    session.speechGen++;
    session.speechAbort?.abort();
    if (this.session === session) this.session = undefined;
    const detail =
      reason === "operator"
        ? "Call ended by the operator."
        : reason === "idle-timeout"
          ? `Call ended: ${Math.round(this.idleTimeoutMs / 60_000)} minutes of silence — a live mic doesn't stay open on a quiet room.`
          : reason === "max-length"
            ? `Call ended: the ${Math.round(this.maxSessionMs / 60_000)}-minute session limit. Start a new call to keep talking.`
            : reason === "kill-phrase"
              ? "Call ended: the kill phrase tripped the kill switch through the normal /stop path."
              : "Call ended: voice was turned off in Settings mid-call.";
    const snapshot: VoiceSessionStateData = {
      ok: true,
      detail,
      active: false,
      sessionId: session.id,
      phase: "ended",
      startedAt: session.startedAt,
      elapsedMs: this.now() - session.startedAt,
      endedReason: reason,
      turns: session.turns,
      lastLatency: session.lastLatency,
    };
    this.endedSnapshot = snapshot;
    return snapshot;
  }
}
