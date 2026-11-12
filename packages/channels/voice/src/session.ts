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
 * Voice that answers (v0.9.7): the 0.9.6 field call heard Glenn
 * (the VAD counted sixteen sentences) and still never spoke —
 * the app's recognizer only POSTed on a FINAL Speech-framework
 * result, and nothing ever ended the audio for a sentence, so
 * no transcript ever completed a turn (voice-turns.jsonl has
 * zero built-in entries). The app's half of that fix is in the
 * app (partials tracked, endAudio() at a sentence's end). This
 * half: a call now OPENS by speaking — one greeting segment is
 * queued before any turn (below), through whichever mouth the
 * call resolved, so the speech-out path proves itself in the
 * first second instead of after the first unanswered minute.
 * The greeting is a segment, not a turn: no transcript, no job,
 * no turn record — and barge-in cuts it like any other speech.
 *
 * Voice, smoothed (v0.9.8): the 0.9.7 field call answered — and
 * took 8–16 s of brain time to say "Hi", because a spoken turn
 * ran the identical unbounded job a typed research request runs,
 * and the turn record's single jobMs couldn't say where the time
 * went. Three answers here (the fast lane itself lives in the
 * control plane + runtime): the latency record now splits jobMs
 * into the stages the pipeline measures — queueMs (utterance end
 * → this turn began processing: the serial chain's wait), and
 * the job's own shieldMs / modelMs / hops, measured around the
 * ingress scan and the model calls and delivered back with the
 * reply (JobDeliveryStats) — and a turn whose job is still
 * running 2.5 s after it started processing queues ONE spoken
 * filler ("Just a second.") through the same segment path as
 * any speech, so a slow answer isn't met with dead air. The
 * filler is a segment, never a turn: no transcript, no record,
 * barge-in drops it like any unfetched speech.
 *
 * Voice you can test (v0.9.9): the 0.9.8 field call's staging
 * named the Shield scan as the biggest single chunk of a voice
 * turn's wait (6–10 s of a 10–19 s reply), and the operator
 * asked for a switch. Config now carries shieldScan (default
 * ON, only a literal false turns it off): when off, the
 * ChannelHost skips the ingress scan for VOICE turns only, and
 * the skip rides the job's delivery stats back here, where the
 * turn records it three ways — the scanSkippedByOperator flag
 * on the turn record, shieldMs 0 with shieldSkipped on the
 * latency, and the words in the detail. Nothing else about the
 * turn changes: same secret-guard, same caps, same receipts.
 *
 * Fast voice scans (v0.9.10): with the switch ON, the scan that
 * remains is the Shield's fast mode — deterministic patterns
 * only, the semantic LLM stage skipped (~1–2 s against the full
 * review's ~7–12 s, measured live). Typed messages keep the
 * full review. The mode rides the same delivery stats back and
 * is recorded the same three ways (shieldFastMode on the turn,
 * the latency, and the words in the detail), so a turn's record
 * always says which scan it got: full, fast, or none.
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
  type VoiceShieldMode,
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
  type VoiceCallResult,
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
  /** v0.9.8: utterance end → this turn began processing — the
   *  serial turn chain's wait, measured at the chain (for a
   *  built-in transcript, from the moment the app posted it).
   *  Transcription time is NOT in here: the endpoint path starts
   *  its turn before transcribing, so sttMs stays separate. */
  queueMs: number;
  /** Transcript → the host's reply (scan, job, settlement). */
  jobMs: number;
  /** v0.9.8: the job's Agent-Shield ingress scan, measured by
   *  the ChannelHost around the scan itself and delivered back
   *  with the reply. Absent when the delivery carried no stats
   *  (a locally-composed or timed-out turn). */
  shieldMs?: number;
  /** v0.9.8: total measured time inside the job's model calls,
   *  summed by the control plane (Governor-refused calls count
   *  as calls that never reached the provider and are excluded;
   *  the approver-decision call is a separate path and is also
   *  excluded — see comm-server). Absent like shieldMs. */
  modelMs?: number;
  /** v0.9.8: how many model calls the job made (issued or
   *  provider-refused), counted by the control plane. */
  hops?: number;
  /** v0.9.9: the operator's Shield-scan switch was OFF for this
   *  turn, so the ChannelHost skipped the ingress scan on
   *  purpose (scan-skipped-by-operator). shieldMs is 0 then —
   *  this flag is what keeps that 0 from reading as "scanned,
   *  fast". Absent on every scanned turn. */
  shieldSkipped?: boolean;
  /** v0.9.10: this turn's ingress scan ran in the Shield's
   *  fast mode (deterministic patterns only, the semantic
   *  stage skipped). Absent on full-review scans and on
   *  skipped turns — the three scan outcomes stay distinct
   *  in the record. */
  shieldFastMode?: boolean;
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
  /** v0.9.9: this turn's job ran with the ingress Shield scan
   *  skipped at the operator's Settings → Voice switch
   *  (scan-skipped-by-operator). Recorded on the turn and in
   *  voice-turns.jsonl — a skipped scan is a stated fact about
   *  the turn, never a silent gap in its record. */
  scanSkippedByOperator?: boolean;
  /** v0.9.10: this turn's ingress Shield scan ran in fast
   *  mode (deterministic patterns only). Recorded on the turn
   *  and in voice-turns.jsonl, like the skip — which of the
   *  three scans a turn got is always a stated fact. */
  shieldFastMode?: boolean;
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
  /** v0.9.11: the call's Shield mode for spoken turns,
   *  resolved at call start from the operator's Shield-scan
   *  switch — "fast" (switch on; the gate's fast mode) or
   *  "off" (switch off; spoken turns skip the ingress scan).
   *  The app shows it as a chip in the call strip: the state
   *  the operator kept having to dig through Settings to
   *  check, visible mid-call instead. */
  shieldMode?: VoiceShieldMode;
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
  /** v0.9.11: the call's Shield mode (see VoiceSessionStateData)
   *  — resolved from the same config read that resolved the
   *  engines, fixed for the call like they are. */
  shieldMode: VoiceShieldMode;
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

/** v0.9.7: the call's opening line — queued as the session's
 *  first segment the moment a call starts (see the header).
 *  Fixed text on purpose: it is the product introducing itself,
 *  not a model output, so it is never scanned, jobbed, or
 *  receipted — it only has to be spoken, in the call's own
 *  voice, before anything else can be. */
export const VOICE_GREETING_TEXT =
  "Hi — I'm GUS, running on your machine. What would you like me to do?";

/** The greeting segment's turn index: no turn owns it. Turn
 *  records are indexed from 0, so -1 can never collide with a
 *  real turn — and the speech machinery's per-turn bookkeeping
 *  (interrupted flags, latency) simply doesn't apply to it. */
const GREETING_TURN_INDEX = -1;

/** v0.9.8: the spoken filler for a slow turn — queued once when
 *  a turn's job is still running this long after the turn started
 *  processing (see completeTurn). Fixed text, like the greeting:
 *  it is the product's own voice bridging a wait, not a model
 *  output — never scanned, jobbed, or recorded as a turn. */
export const VOICE_FILLER_TEXT = "Just a second.";

/** How long a turn's job may run before the filler is queued. */
const DEFAULT_FILLER_DELAY_MS = 2_500;

/** The filler's sentence index within its turn: reply sentences
 *  are indexed from 0, so -1 marks "not a reply sentence" — the
 *  segment belongs to the turn (a reply stream's supersede keeps
 *  it, an interrupt drops it) without pretending to be part of
 *  the answer. */
const FILLER_SENTENCE_INDEX = -1;

export class VoiceSessionService {
  private fetchFn: FetchFn;
  private now: () => number;
  private idleTimeoutMs: number;
  private maxSessionMs: number;
  private silenceMs?: number;
  private vadThreshold?: number;
  private probeTimeoutMs: number;
  private fillerDelayMs: number;
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
      fillerDelayMs?: number;
    },
  ) {
    this.fetchFn = opts?.fetchFn ?? fetch;
    this.now = opts?.now ?? (() => Date.now());
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessionMs = opts?.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
    this.silenceMs = opts?.silenceMs;
    this.vadThreshold = opts?.vadThreshold;
    this.probeTimeoutMs = opts?.probeTimeoutMs ?? 2_500;
    this.fillerDelayMs = opts?.fillerDelayMs ?? DEFAULT_FILLER_DELAY_MS;
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
      // v0.9.11: the Shield mode rides the config this call
      // already resolved — switch on means the gate's fast
      // mode (v0.9.10), off means spoken turns skip the scan.
      shieldMode: config.shieldScan ? "fast" : "off",
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
    // v0.9.7: the call opens by speaking — the greeting segment
    // is queued before start() answers, so the app's first
    // segment poll already has it. A greeting that fails to
    // synthesize (endpoint mouth) doesn't fail the call: the
    // reason rides the start detail, the way a mid-reply speech
    // failure rides its turn.
    const greetingNote = await this.speakGreeting(session, config);
    return {
      ...this.state(session.id),
      detail:
        "Call started. Speak naturally — a pause ends your turn. Talking over a reply cuts it off; \"GUS stop\" ends the call and trips the kill switch." +
        (speechNotice ? ` ${speechNotice}` : "") +
        (greetingNote ? ` ${greetingNote}` : ""),
    };
  }

  /**
   * v0.9.7: queue the call's one greeting segment through the
   * mouth the call resolved — a speak-text segment for built-in
   * TTS, one synthesize() call for an endpoint, exactly like a
   * one-sentence reply. It takes the speech generation like any
   * speech: an interrupt bumps the generation, aborts an
   * in-flight synthesis, and drops the segment unfetched, so
   * talking over the greeting cuts it precisely like talking
   * over a reply. Returns the failure note for the start detail
   * when the endpoint mouth couldn't speak it (built-in can't
   * fail here — queueing text is all it does).
   */
  private async speakGreeting(
    session: ActiveSession,
    config: VoiceConfig,
  ): Promise<string | undefined> {
    const gen = ++session.speechGen;
    if (session.ttsMode === "local") {
      session.segments.push({
        seq: session.nextSeq++,
        turnIndex: GREETING_TURN_INDEX,
        sentenceIndex: 0,
        audioBase64: "",
        audioContentType: "",
        text: VOICE_GREETING_TEXT,
        fetched: false,
      });
      return undefined;
    }
    const abort = new AbortController();
    session.speechAbort = abort;
    session.streaming = true;
    try {
      const out = await synthesize(
        this.fetchFn,
        { baseUrl: config.ttsBaseUrl, model: config.ttsModel, voice: config.ttsVoice },
        VOICE_GREETING_TEXT,
        undefined,
        abort.signal,
      );
      if (gen !== session.speechGen || this.session !== session) return undefined;
      session.segments.push({
        seq: session.nextSeq++,
        turnIndex: GREETING_TURN_INDEX,
        sentenceIndex: 0,
        audioBase64: Buffer.from(out.audio).toString("base64"),
        audioContentType: out.contentType,
        fetched: false,
      });
      return undefined;
    } catch (e) {
      if (gen !== session.speechGen || this.session !== session) return undefined;
      return (
        "The opening greeting couldn't be spoken: " +
        (e instanceof SpeechServiceError ? e.message : String(e))
      );
    } finally {
      if (gen === session.speechGen) {
        session.streaming = false;
        session.speechAbort = undefined;
      }
    }
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
        shieldMode: session.shieldMode,
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
    // v0.9.8: arm the spoken filler — if the job is still
    // running when the delay elapses, ONE "Just a second." is
    // queued through the segment path (queueFiller). Disarming
    // the moment the reply lands is what keeps a fast turn
    // filler-free.
    const filler = this.armFiller(session, turn, config);
    let result: VoiceCallResult;
    try {
      result = await this.calls.processTranscript(transcript);
    } finally {
      filler.disarm();
    }
    const jobMs = this.now() - jobStart;
    turn.kind = result.kind;
    // v0.9.9: a scan the operator switched off is stated on the
    // turn, in words — the stock detail ("Heard, scanned, and
    // answered…") must not claim a scan that never ran.
    const scanSkipped = result.stats?.shieldSkipped === true;
    if (scanSkipped) turn.scanSkippedByOperator = true;
    // v0.9.10: a fast-mode scan is stated too — the stock detail
    // must not imply the full semantic review read the words
    // when deterministic patterns were all that ran.
    const shieldFastMode = result.stats?.shieldFastMode === true;
    if (shieldFastMode) turn.shieldFastMode = true;
    turn.detail =
      (scanSkipped
        ? `${result.detail} Shield scan skipped for this turn — scan-skipped-by-operator (the Settings → Voice switch is off).`
        : shieldFastMode
          ? `${result.detail} Shield scan ran in fast mode for this turn (deterministic patterns only; typed messages still get the full semantic review).`
          : result.detail) +
      (turn.via === "local" ? " (Built-in transcription on this Mac.)" : "");
    turn.replyText = result.replyText;
    const latency: VoiceTurnLatency = {
      utteranceEndAt,
      sttMs,
      // v0.9.8: the chain's wait, and the job's own measured
      // stages as delivered back with its reply (absent when the
      // delivery carried none).
      queueMs: Math.max(0, turn.startedAt - utteranceEndAt),
      jobMs,
      ...(result.stats
        ? {
            shieldMs: result.stats.shieldMs,
            modelMs: result.stats.modelMs,
            hops: result.stats.hops,
            ...(result.stats.shieldSkipped ? { shieldSkipped: true } : {}),
            ...(result.stats.shieldFastMode ? { shieldFastMode: true } : {}),
          }
        : {}),
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
   * v0.9.8: arm a turn's spoken filler. The timer is the whole
   * mechanism: it fires at most once, only while the turn's job
   * is still running (completeTurn disarms it the moment the
   * reply lands), and queueFiller re-checks the world before
   * queueing anything. The delay runs on the REAL clock even
   * when the session's record clock is injected — a filler is
   * about the operator's experienced wait, not the ledger's.
   */
  private armFiller(
    session: ActiveSession,
    turn: VoiceSessionTurn,
    config: VoiceConfig,
  ): { disarm: () => void } {
    const gen = session.speechGen;
    const timer = setTimeout(() => {
      void this.queueFiller(session, turn, config, gen);
    }, this.fillerDelayMs);
    timer.unref?.();
    return { disarm: () => clearTimeout(timer) };
  }

  /**
   * v0.9.8: queue the one filler segment for a slow turn —
   * through the SAME segment path as any speech (a speak-text
   * segment for the built-in mouth, one synthesize() call for
   * an endpoint), owned by the turn itself so the reply's
   * stream keeps it (it precedes the answer in seq order) and
   * an interrupt drops it unfetched like any speech. Guards,
   * checked before AND after any synthesis: the session must
   * still be this call, and the speech generation must be the
   * one the filler was armed under — an interrupt bumps it, and
   * the reply's own stream bumps it too, so a filler can never
   * land after the answer started speaking. Best-effort by
   * design: a failed synthesis queues nothing and fails
   * nothing — comfort must not become a failure mode.
   */
  private async queueFiller(
    session: ActiveSession,
    turn: VoiceSessionTurn,
    config: VoiceConfig,
    genAtArm: number,
  ): Promise<void> {
    if (this.session !== session || genAtArm !== session.speechGen) return;
    if (session.ttsMode === "local") {
      session.segments.push({
        seq: session.nextSeq++,
        turnIndex: turn.index,
        sentenceIndex: FILLER_SENTENCE_INDEX,
        audioBase64: "",
        audioContentType: "",
        text: VOICE_FILLER_TEXT,
        fetched: false,
      });
      return;
    }
    let out: { audio: Uint8Array; contentType: string };
    try {
      out = await synthesize(
        this.fetchFn,
        { baseUrl: config.ttsBaseUrl, model: config.ttsModel, voice: config.ttsVoice },
        VOICE_FILLER_TEXT,
        undefined,
        session.speechAbort?.signal,
      );
    } catch {
      return;
    }
    if (this.session !== session || genAtArm !== session.speechGen) return;
    session.segments.push({
      seq: session.nextSeq++,
      turnIndex: turn.index,
      sentenceIndex: FILLER_SENTENCE_INDEX,
      audioBase64: Buffer.from(out.audio).toString("base64"),
      audioContentType: out.contentType,
      fetched: false,
    });
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
        /** v0.9.9: present (and true) only when the operator's
         *  switch skipped this turn's ingress Shield scan. */
        scanSkippedByOperator?: boolean;
        /** v0.9.10: present (and true) only when this turn's
         *  ingress scan ran in the Shield's fast mode. */
        shieldFastMode?: boolean;
        latency?: VoiceTurnLatency;
      } = {
        ts: this.now(),
        index: turn.index,
        ...(turn.transcript !== undefined ? { transcript: turn.transcript } : {}),
        ...(turn.via !== undefined ? { stt: turn.via } : {}),
        kind: turn.kind,
        detail: turn.detail,
        ...(turn.scanSkippedByOperator ? { scanSkippedByOperator: true } : {}),
        ...(turn.shieldFastMode ? { shieldFastMode: true } : {}),
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
      shieldMode: session.shieldMode,
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
