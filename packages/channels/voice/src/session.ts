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
 * measured here, where the stages actually happen.
 *
 * Hearing (v0.9.2): the session also keeps a ledger of what the
 * ears receive — chunks in, per-chunk energy (the VAD's own
 * numbers), the open utterance's age, utterances completed —
 * exposed in the state. A call that never takes a turn is
 * diagnosed from the app's in-call strip, not guessed at.
 *
 * On the record (v0.9.4): the first 0.9.3 call's turns died
 * silently — quiet audio (loudest chunk RMS 1356) transcribed
 * empty, and the in-memory turn records evaporated when the
 * session finished, leaving nothing to diagnose from. Three
 * answers: utterances are gain-normalized before transcription
 * (vad.ts), every settled turn is appended to
 * <stateDir>/voice-turns.jsonl as it reaches its terminal
 * state, and the finished session's snapshot rides later state
 * polls as lastSession instead of vanishing.
 *
 * Built in (v0.9.6): the 0.9.5 field call heard Glenn fine and
 * still never spoke — every turn died at an unreachable LAN
 * endpoint (the Speaches container on another machine), so the
 * transcript never existed and there was nothing to answer. A
 * call no longer depends on Docker or the LAN: each speech half
 * has an engine in config (built-in by default), and the app's
 * own Speech framework / AVSpeechSynthesizer are the built-in
 * engines. At call start the session resolves its modes —
 * built-in stays built-in; a chosen endpoint is probed
 * (speech.ts) and an unreachable one resolves to built-in FOR
 * THIS CALL, with the notice on the session state, never a
 * silent swap. In built-in STT mode the PCM stream still feeds
 * the hearing ledger, but utterances are not transcribed here:
 * the app POSTs each final transcript to submitTranscript(),
 * which takes the IDENTICAL turn below (processTranscript) —
 * the ears changed, the pipeline didn't. In built-in TTS mode
 * reply sentences are queued as speak-text segments for the
 * app's synthesizer instead of synthesized audio.
 *
 * The microphone's liveness is the app's side of the contract:
 * this service only ever sees audio the app chose to stream, and
 * only while a session the operator started is active. There is
 * no listen-outside-a-call path in this package.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadVoiceConfig,
  voiceConfigured,
  type VoiceConfig,
  type VoiceEngine,
} from "./config.js";
import {
  probeEndpoint,
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
  normalizePcm16Gain,
  wrapPcm16AsWav,
  chunkMs,
  chunkRms,
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
  /** v0.9.6: which ears produced the transcript — the built-in
   *  recognizer in the app ("local") or the endpoint service
   *  ("endpoint"). Rides the durable turn record, so a call's
   *  post-mortem says which path its words took. */
  via?: VoiceEngine;
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

/** v0.9.2: the session's hearing ledger — what the ears are
 *  actually receiving, exposed in the state so a call that
 *  "just listens" can be diagnosed from the app's in-call
 *  strip instead of guessed at. Levels are the VAD's own
 *  AC-energy numbers (chunkRms), so the strip shows exactly
 *  what the segmenter decided with. */
export interface VoiceSessionHearingData {
  /** Audio chunks the app has streamed into this session. */
  chunksReceived: number;
  /** The most recent chunk's energy, and the loudest so far. */
  lastRms: number;
  maxRms: number;
  /** Audio ms accumulated in the utterance currently open;
   *  0 when none is open. */
  inUtteranceMs: number;
  /** Utterances the VAD has closed and queued as turns. */
  utterancesCompleted: number;
}

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
  /** v0.9.6: the call's RESOLVED speech modes — what this call
   *  is actually using after the call-start probe, which may
   *  differ from the configured engines (an unreachable endpoint
   *  resolves to "local" for the call). The app reads these at
   *  call start to decide whether to run its recognizer and its
   *  synthesizer. */
  sttMode?: VoiceEngine;
  ttsMode?: VoiceEngine;
  /** v0.9.6: the fallback notice, when a resolved mode differs
   *  from the configured engine — plain words on the state, e.g.
   *  "Speech service unreachable — using built-in voice for
   *  this call." */
  speechNotice?: string;
  turns: VoiceSessionTurn[];
  lastLatency?: VoiceTurnLatency;
  hearing?: VoiceSessionHearingData;
  /** v0.9.4: the most recently finished call's snapshot, riding
   *  on state polls that aren't about it — a poller that lost
   *  the session id still sees how the last call went instead
   *  of an empty record. Cleared when a new session starts;
   *  a finished snapshot never nests one of its own. */
  lastSession?: VoiceSessionStateData;
}

export interface VoiceAudioSegmentData {
  ok: boolean;
  detail: string;
  seq?: number;
  turnIndex?: number;
  sentenceIndex?: number;
  audioBase64?: string;
  audioContentType?: string;
  /** v0.9.6: a speak-text segment (built-in TTS mode) — the app
   *  speaks this text with its own synthesizer. Present instead
   *  of audioBase64; a segment carries one or the other. */
  text?: string;
}

interface AudioSegment {
  seq: number;
  turnIndex: number;
  sentenceIndex: number;
  audioBase64: string;
  audioContentType: string;
  /** v0.9.6: speak-text for built-in TTS (see the data shape). */
  text?: string;
  fetched: boolean;
}

interface ActiveSession {
  id: string;
  startedAt: number;
  lastSpeechAt: number;
  /** v0.9.6: the resolved speech modes for THIS call (see
   *  VoiceSessionStateData) — fixed at call start; a mid-call
   *  settings edit lands on the next call, like every other
   *  voice setting. */
  sttMode: VoiceEngine;
  ttsMode: VoiceEngine;
  /** v0.9.6: the fallback notice, when resolution fell back. */
  speechNotice?: string;
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
  /** v0.9.2: the hearing ledger (see VoiceSessionHearingData).
   *  openMs is the live accumulator behind inUtteranceMs —
   *  audio ms pushed while an utterance is open; it resets
   *  when the utterance completes or the stream goes quiet. */
  hearing: {
    chunksReceived: number;
    lastRms: number;
    maxRms: number;
    openMs: number;
    utterancesCompleted: number;
  };
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
  private probeTimeoutMs: number;
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
      probeTimeoutMs?: number;
    },
  ) {
    this.fetchFn = opts?.fetchFn ?? fetch;
    this.now = opts?.now ?? (() => Date.now());
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessionMs = opts?.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
    this.silenceMs = opts?.silenceMs;
    this.vadThreshold = opts?.vadThreshold;
    this.probeTimeoutMs = opts?.probeTimeoutMs ?? 2_500;
    this.calls = new VoiceCallService(stateDir, adapter, approvals, {
      fetchFn: this.fetchFn,
      replyTimeoutMs: opts?.replyTimeoutMs,
    });
  }

  // ------------------------------------------------------------ lifecycle

  /** Open a call. The guards are the 0.9.0 call's guards, word
   *  for word: voice off or unconfigured refuses loudly, before
   *  any audio is accepted. One call at a time — a second start
   *  while one is live answers with the live session's state.
   *
   *  v0.9.6: async because opening a call now RESOLVES its speech
   *  modes: a built-in engine resolves to itself; an endpoint
   *  engine is probed (short timeout, both probes in parallel)
   *  and resolves to the endpoint only if it answers — otherwise
   *  to built-in for this call, with the notice on the state.
   *  The config on file is never rewritten by a fallback: fix
   *  the endpoint and the next call uses it again. */
  async start(): Promise<VoiceSessionStateData> {
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
          "Voice is off. Enable it in Settings → Voice, then try again. Nothing was sent to GUS.",
      };
    }
    if (!voiceConfigured(config)) {
      return {
        ok: false,
        active: false,
        turns: [],
        detail:
          "Voice is enabled but an endpoint it needs is missing from its settings. Nothing was sent to GUS — check Settings → Voice.",
      };
    }
    const { sttMode, ttsMode, speechNotice } = await this.resolveModes(config);
    const now = this.now();
    const session: ActiveSession = {
      id: `call-${now.toString(36)}-${this.counter++}`,
      startedAt: now,
      lastSpeechAt: now,
      sttMode,
      ttsMode,
      speechNotice,
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
      hearing: {
        chunksReceived: 0,
        lastRms: 0,
        maxRms: 0,
        openMs: 0,
        utterancesCompleted: 0,
      },
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
        "Call started. Speak naturally — a pause ends your turn. Talking over a reply cuts it off; \"GUS stop\" ends the call and trips the kill switch." +
        (speechNotice ? ` ${speechNotice}` : ""),
    };
  }

  /** v0.9.6: resolve one call's speech modes from the configured
   *  engines. Built-in resolves to itself without any network;
   *  an endpoint resolves to itself only when the probe answers.
   *  One notice covers the call even if both halves fell back —
   *  the operator needs the fact and the consequence, not a
   *  per-service post-mortem at call start. */
  private async resolveModes(config: VoiceConfig): Promise<{
    sttMode: VoiceEngine;
    ttsMode: VoiceEngine;
    speechNotice?: string;
  }> {
    const [sttOk, ttsOk] = await Promise.all([
      config.sttEngine === "endpoint"
        ? probeEndpoint(this.fetchFn, config.sttBaseUrl, this.probeTimeoutMs)
        : Promise.resolve(true),
      config.ttsEngine === "endpoint"
        ? probeEndpoint(this.fetchFn, config.ttsBaseUrl, this.probeTimeoutMs)
        : Promise.resolve(true),
    ]);
    const sttMode: VoiceEngine =
      config.sttEngine === "endpoint" && !sttOk ? "local" : config.sttEngine;
    const ttsMode: VoiceEngine =
      config.ttsEngine === "endpoint" && !ttsOk ? "local" : config.ttsEngine;
    const fellBack =
      sttMode !== config.sttEngine || ttsMode !== config.ttsEngine;
    return {
      sttMode,
      ttsMode,
      speechNotice: fellBack
        ? "Speech service unreachable — using built-in voice for this call."
        : undefined,
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
    // The hearing ledger first (v0.9.2): every accepted chunk is
    // counted and measured with the VAD's own energy function,
    // so the state the app polls shows exactly what the
    // segmenter is hearing — level, peak, and whether an
    // utterance is open and how long it has been open.
    const rms = Math.round(chunkRms(chunk));
    session.hearing.chunksReceived++;
    session.hearing.lastRms = rms;
    if (rms > session.hearing.maxRms) session.hearing.maxRms = rms;
    const pushed = session.segmenter.push(chunk, this.now());
    if (pushed.speech) session.lastSpeechAt = this.now();
    if (pushed.utterance) {
      session.hearing.utterancesCompleted++;
      session.hearing.openMs = 0;
    } else if (session.segmenter.inUtterance) {
      session.hearing.openMs += chunkMs(chunk);
    } else {
      session.hearing.openMs = 0;
    }
    if (pushed.utterance && session.sttMode === "endpoint") {
      const utterance = pushed.utterance;
      const endMs = pushed.utteranceEndMs ?? this.now();
      session.chain = session.chain.then(() => this.runUtterance(session, utterance, endMs));
    }
    // v0.9.6, built-in STT: the utterance the VAD just closed is
    // deliberately NOT queued — the audio was never buffered for
    // transcription (the segmenter still ran, above, so the
    // hearing ledger is honest). The app's recognizer owns the
    // words in this mode and POSTs them via submitTranscript.
    return { ok: true, detail: "Heard." };
  }

  /**
   * v0.9.6: one final transcript from the app's built-in
   * recognizer (built-in STT mode). The words queue onto the
   * session's serial turn chain and take the identical turn a
   * transcribed utterance takes — processTranscript, with its
   * Shield scan, speech acts, caps, and receipts. An empty
   * transcript is a settled, recorded turn that goes nowhere:
   * loud in the log, never jobbed. In endpoint STT mode this
   * route refuses — the ears for the call were resolved at its
   * start, and a second transcript path mid-call would make
   * turns the operator never spoke possible.
   */
  submitTranscript(sessionId: string, text: string): { ok: boolean; detail: string } {
    const session = this.session;
    if (!session || session.id !== sessionId) {
      return { ok: false, detail: "No live call by that id — the transcript was dropped, nothing was sent to GUS." };
    }
    this.tick();
    if (this.session !== session) {
      return { ok: false, detail: "The call ended (timeout) as that transcript arrived — it was dropped." };
    }
    if (session.sttMode !== "local") {
      return {
        ok: false,
        detail:
          "This call is transcribing through its speech endpoint — a built-in transcript was refused and nothing was sent to GUS.",
      };
    }
    session.lastSpeechAt = this.now();
    const postedAt = this.now();
    const trimmed = text.trim();
    session.chain = session.chain.then(() =>
      this.runTranscriptTurn(session, trimmed, postedAt),
    );
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
      audioBase64: seg.text !== undefined ? undefined : seg.audioBase64,
      audioContentType: seg.text !== undefined ? undefined : seg.audioContentType,
      text: seg.text,
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
        sttMode: session.sttMode,
        ttsMode: session.ttsMode,
        speechNotice: session.speechNotice,
        turns: session.turns,
        lastLatency: session.lastLatency,
        hearing: this.hearingData(session),
        lastSession: this.endedSnapshot,
      };
    }
    if (this.endedSnapshot && this.endedSnapshot.sessionId === sessionId) {
      return this.endedSnapshot;
    }
    return {
      ok: false,
      active: false,
      turns: [],
      detail: "No call by that id.",
      lastSession: this.endedSnapshot,
    };
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
      // v0.9.4: the payload is gain-normalized first — a quiet
      // voice at a sane peak, so the transcription service gets
      // audio it can actually hear (see normalizePcm16Gain).
      const sttStart = this.now();
      let transcript: string;
      try {
        transcript = await transcribe(
          this.fetchFn,
          { baseUrl: config.sttBaseUrl, model: config.sttModel },
          wrapPcm16AsWav(normalizePcm16Gain(pcm)),
          "audio/wav",
        );
      } catch (e) {
        turn.detail =
          e instanceof SpeechServiceError ? e.message : `Transcription failed: ${String(e)}`;
        return;
      }
      const sttMs = this.now() - sttStart;
      turn.transcript = transcript;
      turn.via = "endpoint";

      await this.completeTurn(session, turn, config, transcript, utteranceEndAt, sttMs);
    } finally {
      // Every path that created the turn settles here exactly
      // once — transcription failure, mid-call disable, normal
      // completion, kill-phrase stop — so the durable record is
      // written here, where no outcome can slip past it.
      this.appendTurnRecord(turn);
      session.processing = false;
    }
  }

  /**
   * v0.9.6: a turn whose words arrived as a transcript (the
   * app's built-in recognizer, via submitTranscript). Everything
   * after the ears is completeTurn — the same code the endpoint
   * path runs — so a built-in transcript is scanned, capped,
   * receipted, and answered identically to a transcribed one.
   * sttMs records 0: the recognition happened in the app, in
   * parallel with the talking, and this service does not invent
   * a number it didn't measure.
   */
  private async runTranscriptTurn(
    session: ActiveSession,
    transcript: string,
    postedAt: number,
  ): Promise<void> {
    if (this.session !== session) return;
    session.processing = true;
    const turn: VoiceSessionTurn = {
      index: session.turns.length,
      startedAt: this.now(),
      kind: "unavailable",
      detail: "",
      interrupted: false,
      via: "local",
    };
    session.turns.push(turn);
    try {
      const config = loadVoiceConfig(this.stateDir);
      if (!config.enabled || !voiceConfigured(config)) {
        turn.detail =
          "Voice was turned off or unconfigured in Settings mid-call — the call ended and that transcript went nowhere.";
        this.finish(session, "disabled");
        return;
      }
      if (!transcript) {
        // Loud, on the record, and nowhere else: an empty final
        // from the recognizer is a settled turn that never
        // becomes a job, a scan, or a reply.
        turn.detail =
          "The built-in recognizer handed over an empty transcript — nothing was sent to GUS.";
        return;
      }
      turn.transcript = transcript;
      await this.completeTurn(session, turn, config, transcript, postedAt, 0);
    } finally {
      this.appendTurnRecord(turn);
      session.processing = false;
    }
  }

  /**
   * The turn from transcript-in-hand onward — shared verbatim by
   * the endpoint path (runUtterance) and the built-in path
   * (runTranscriptTurn): the job through processTranscript, the
   * latency record, the spoken reply, the kill-phrase ending.
   * How the words arrived is the caller's business; what happens
   * to them is not allowed to differ.
   */
  private async completeTurn(
    session: ActiveSession,
    turn: VoiceSessionTurn,
    config: VoiceConfig,
    transcript: string,
    utteranceEndAt: number,
    sttMs: number,
  ): Promise<void> {
    const jobStart = this.now();
    const result = await this.calls.processTranscript(transcript);
    const jobMs = this.now() - jobStart;
    turn.kind = result.kind;
    turn.detail =
      turn.via === "local"
        ? `${result.detail} (Built-in transcription on this Mac.)`
        : result.detail;
    turn.replyText = result.replyText;
    const latency: VoiceTurnLatency = {
      utteranceEndAt,
      sttMs,
      jobMs,
      totalMs: this.now() - utteranceEndAt,
    };
    turn.latency = latency;
    session.lastLatency = latency;

    // --- mouth: sentence by sentence, first one fast -----------
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
  }

  /**
   * v0.9.4: the durable turn log — one JSON line per settled
   * turn in <stateDir>/voice-turns.jsonl, in the same append
   * shape as jobs.jsonl and receipts.jsonl. The in-memory turn
   * records evaporate with the session (the first 0.9.3 call's
   * failed turns left nothing behind to diagnose); this is the
   * copy that survives. Best-effort on purpose: a failed append
   * is swallowed — the log is evidence, never machinery, and
   * must not break the call it describes.
   */
  private appendTurnRecord(turn: VoiceSessionTurn): void {
    try {
      const rec: {
        ts: number;
        index: number;
        transcript?: string;
        stt?: VoiceEngine;
        kind: string;
        detail: string;
        latency?: VoiceTurnLatency;
      } = {
        ts: this.now(),
        index: turn.index,
        ...(turn.transcript !== undefined ? { transcript: turn.transcript } : {}),
        ...(turn.via !== undefined ? { stt: turn.via } : {}),
        kind: turn.kind,
        detail: turn.detail,
        ...(turn.latency !== undefined ? { latency: turn.latency } : {}),
      };
      appendFileSync(join(this.stateDir, "voice-turns.jsonl"), JSON.stringify(rec) + "\n");
    } catch {
      /* a lost line loses a clue, never a call */
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
        // v0.9.6, built-in TTS: no service to call — the sentence
        // itself is the segment, and the app's synthesizer is the
        // mouth. The generation checks above and below are the
        // barge-in contract, unchanged: an interrupt that lands
        // before a segment is fetched drops it unsaid.
        if (session.ttsMode === "local") {
          session.segments.push({
            seq: session.nextSeq++,
            turnIndex: turn.index,
            sentenceIndex: i,
            audioBase64: "",
            audioContentType: "",
            text: sentences[i],
            fetched: false,
          });
          if (first) {
            first = false;
            onFirstSegment();
          }
          continue;
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
      sttMode: session.sttMode,
      ttsMode: session.ttsMode,
      speechNotice: session.speechNotice,
      turns: session.turns,
      lastLatency: session.lastLatency,
      hearing: this.hearingData(session),
    };
    this.endedSnapshot = snapshot;
    return snapshot;
  }

  /** The public shape of the session's hearing ledger: the
   *  internal open-utterance accumulator becomes the exposed
   *  inUtteranceMs (0 whenever no utterance is open). */
  private hearingData(session: ActiveSession): VoiceSessionHearingData {
    return {
      chunksReceived: session.hearing.chunksReceived,
      lastRms: session.hearing.lastRms,
      maxRms: session.hearing.maxRms,
      inUtteranceMs: session.segmenter.inUtterance ? session.hearing.openMs : 0,
      utterancesCompleted: session.hearing.utterancesCompleted,
    };
  }
}
