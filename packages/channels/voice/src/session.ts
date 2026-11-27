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
 *
 * Watch mode (v0.37.0): the call gains eyes. While the operator
 * has Watch on (an explicit per-call tap in the app — it never
 * auto-starts), the app streams small still frames from the
 * call's camera(s); this service holds the LATEST frame per
 * camera in memory as the session's eyes and attaches them to
 * the next turn — spoken, typed, or photo — as image input,
 * framed by the host as a live view rather than an attachment.
 * On the baseline cadence a frame whose perceptual hash says
 * the view MATERIALLY changed (and only then) may queue one
 * ambient observation turn: the fixed observation instruction
 * through the identical pipeline, its reply spoken like any
 * turn — unless the model answers with the nothing-to-report
 * sentinel, which is recorded and never spoken. Frames are
 * stream-and-discard: held in memory only, never written to
 * disk, never in the turn records (an observation turn records
 * that it looked, never what it saw), and dropped the moment
 * Watch turns off or the call ends. The camera's liveness is
 * the app's side of the contract exactly as the microphone's
 * is: this service only ever holds frames the app chose to
 * send, only while Watch is on in a live call.
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
  sanitizeVoiceImages,
  MAX_VOICE_IMAGES,
  VOICE_CONVERSATION,
  type PendingApprovalLookup,
  type VoiceAdapter,
  type VoiceCallResult,
} from "./voice-channel.js";
import type { MessageImage } from "@gus/shared";
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
  /** v0.36.0: how many photos the operator sent with this
   *  turn (the in-call camera). The image data itself is
   *  never recorded — the count is the record, exactly as
   *  on the chat transcript (PanelChatEntry.photos). Watch
   *  mode's frames (v0.37.0) are NOT counted here: the
   *  operator didn't send them, the call's camera is simply
   *  on, and a turn that carried the live view says so in
   *  its detail instead. */
  photos?: number;
  /** v0.37.0: this turn is an ambient Watch observation —
   *  the camera's view changed materially and GUS looked on
   *  its own initiative. It has no transcript (nobody spoke);
   *  its replyText, when present, is the spoken comment, and
   *  when the model had nothing worth saying the turn
   *  records exactly that and nothing was spoken. Absent on
   *  every operator turn. */
  watch?: boolean;
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
  /** v0.37.0: the call's Watch state — whether the camera
   *  view is streaming to this session, and which cameras
   *  the app says are live. The frames themselves NEVER ride
   *  the state: they are held in memory, attached to turns
   *  as image input, and dropped when Watch turns off or the
   *  call ends. This summary is all a poller ever sees. */
  watch?: { on: boolean; cameras: WatchCamera[] };
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
  /** v0.17.2: the base URL this call's synthesis actually
   *  posts to — the configured endpoint URL for an endpoint
   *  mouth, the bundled supervisor's loopback URL for a bundled
   *  mouth. Resolved with the modes at call start so the three
   *  synthesis sites (greeting, filler, reply stream) all speak
   *  through the mouth the call resolved, never a re-read. For
   *  endpoint calls this is config.ttsBaseUrl verbatim — the
   *  behavior of every call before this field existed. */
  ttsBaseUrl: string;
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
  /** v0.37.0: the session's eyes (Watch mode). frames holds
   *  the LATEST frame per camera — memory only, never written
   *  anywhere, replaced by the next frame and dropped whole
   *  when Watch turns off or the call ends. `consumed` is the
   *  fingerprint of the frame set the last turn (operator or
   *  ambient) actually carried — the change baseline: a new
   *  set is only worth an ambient look when it materially
   *  differs from what a turn already saw. */
  watch: {
    on: boolean;
    /** The camera slots the app says are live (its mode). */
    cameras: WatchCamera[];
    frames: Partial<Record<WatchCamera, MessageImage>>;
    hashes: Partial<Record<WatchCamera, string>>;
    sizes: Partial<Record<WatchCamera, number>>;
    consumed?: WatchFrameSet;
    /** When the last ambient observation was QUEUED — the
     *  rate limit's clock (queueing, not completion, is what
     *  the ceiling governs). 0 = never. */
    lastAmbientAt: number;
    /** When the last frame arrived — while frames keep
     *  arriving, a watched call is not idle (see tick). */
    lastFrameAt: number;
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

// ------------------------------------------------------------ Watch mode (v0.37.0)

/** One of the call's cameras. The app runs the front camera,
 *  the back camera, or — on devices that support multi-cam —
 *  both at once; each live camera has its own frame slot here. */
export type WatchCamera = "front" | "back";

/** The fixed ambient-observation instruction (v0.37.0): when
 *  the camera's view changes materially, THIS text takes the
 *  turn — through the identical pipeline as a spoken turn
 *  (Shield scan, caps, receipts), with the current frames
 *  attached as the live view. Fixed text on purpose, like the
 *  greeting and the filler: it is the product looking, not the
 *  operator speaking, so it never lands in a turn's transcript
 *  field — the turn is marked `watch` instead. */
export const WATCH_OBSERVATION_TEXT =
  "Look at the camera's current view (included with this message as image input) and comment briefly — one or two sentences — only on anything new, notable, or relevant to the conversation so far. " +
  "If there is nothing worth remarking on, reply with exactly: Nothing new to report.";

/** The nothing-worth-saying sentinel (v0.37.0): when an ambient
 *  observation's reply IS this line (after trimming), the turn
 *  records the look and nothing is spoken — a watching GUS that
 *  narrates "nothing new" every few seconds is the chattiness
 *  failure mode this feature exists to avoid. The comparison
 *  is exact on purpose: a near-miss is a real reply and is
 *  spoken, which fails toward conversation, never toward
 *  silence the operator didn't ask for. */
export const WATCH_NOTHING_TO_REPORT = "Nothing new to report.";

/** Ambient observations are rate-limited (v0.37.0): at most one
 *  is QUEUED per this interval, however fast the view changes.
 *  The app samples on a ~12 s baseline, so in practice this
 *  allows roughly every other frame to speak when the scene
 *  keeps changing — SerenAI's proven 15 s comment cadence, and
 *  a hard ceiling on a watching call's chattiness. */
export const WATCH_AMBIENT_MIN_INTERVAL_MS = 15_000;

/** Material change, perceptual (v0.37.0): the app sends a
 *  64-bit average hash (aHash) with each frame — 8×8 luminance
 *  cells, bit set when the cell is brighter than the frame's
 *  average. Two hashes of the same view differ in a handful of
 *  bits (lighting shimmer, sensor noise); a person entering,
 *  a door opening, the camera turning to a new subject flips
 *  far more. More than this many differing bits is a material
 *  change. */
export const WATCH_HASH_DISTANCE_THRESHOLD = 10;

/** Material change, fallback (v0.37.0): when either frame of a
 *  pair carries no hash, the JPEG byte-size delta stands in —
 *  a static scene re-encodes to within a few percent of the
 *  same size, a material change moves it well past this. */
export const WATCH_SIZE_DELTA_THRESHOLD = 0.1;

/** One frame set's change-detection fingerprint: per camera,
 *  the frame's aHash (when the app sent one) and its base64
 *  length. The frames themselves are never part of it — this
 *  is the only trace of a frame that outlives the frame, and
 *  it outlives it only until the session ends. */
export interface WatchFrameSet {
  hashes: Partial<Record<WatchCamera, string>>;
  sizes: Partial<Record<WatchCamera, number>>;
}

/** Hamming distance between two 64-bit aHashes (16 hex chars).
 *  A malformed hash compares as maximally different — a hash
 *  this service can't read must never read as "same view". */
export function watchHashDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Did the view materially change between two frame sets?
 *  A camera appearing or disappearing is a change by itself;
 *  per camera, the perceptual hash decides when both frames
 *  carry one, the size delta otherwise. An absent previous
 *  set (nothing consumed yet) makes any non-empty set a
 *  change — the first frame after Watch turns on is looked
 *  at, as SerenAI looked at its first frame. */
export function watchSetChanged(
  prev: WatchFrameSet | undefined,
  next: WatchFrameSet,
): boolean {
  const cameras = new Set<WatchCamera>([
    ...(Object.keys(prev?.sizes ?? {}) as WatchCamera[]),
    ...(Object.keys(next.sizes) as WatchCamera[]),
  ]);
  if (!prev) return cameras.size > 0;
  for (const cam of cameras) {
    const p = prev.sizes[cam];
    const n = next.sizes[cam];
    if (p === undefined || n === undefined) return true;
    const ph = prev.hashes[cam];
    const nh = next.hashes[cam];
    if (ph && nh) {
      if (watchHashDistance(ph, nh) > WATCH_HASH_DISTANCE_THRESHOLD) return true;
    } else if (Math.abs(n - p) / Math.max(p, 1) > WATCH_SIZE_DELTA_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/** v0.17.2: the bundled-Kokoro resolver the control plane
 *  injects — this package's only window onto the bundled
 *  engine, declared here so the voice package never imports
 *  the engine or its supervisor (the PendingApprovalLookup
 *  pattern). ensureRunning asks the supervisor to have the
 *  server up and reports the model's state; the session then
 *  probes the speech surface itself before trusting it, the
 *  same discipline an endpoint gets. */
export interface BundledTtsStatus {
  serverUp: boolean;
  modelReady: boolean;
  downloading: boolean;
  progress: number | null;
  detail: string;
}

export interface BundledTtsResolver {
  baseUrl: string;
  ensureRunning(): Promise<BundledTtsStatus>;
}

export class VoiceSessionService {
  private fetchFn: FetchFn;
  private now: () => number;
  private idleTimeoutMs: number;
  private maxSessionMs: number;
  private silenceMs?: number;
  private vadThreshold?: number;
  private probeTimeoutMs: number;
  private fillerDelayMs: number;
  private bundledTts?: BundledTtsResolver;
  private calls: VoiceCallService;
  /** v0.37.0: kept from the constructor (it used to be passed
   *  straight through to VoiceCallService) — ambient Watch
   *  observations check it before queueing: while an approval
   *  is parked for the voice conversation, the park owns the
   *  floor and the camera does not start a turn of its own. */
  private approvals: PendingApprovalLookup;
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
      /** v0.17.2: the bundled-Kokoro resolver (see
       *  BundledTtsResolver). Absent in surfaces that can't
       *  supervise the bundled engine — a bundled pick there
       *  resolves to the app voice with the notice saying so. */
      bundledTts?: BundledTtsResolver;
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
    this.bundledTts = opts?.bundledTts;
    this.approvals = approvals;
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
    const { sttMode, ttsMode, ttsBaseUrl, speechNotice } = await this.resolveModes(config);
    const now = this.now();
    const session: ActiveSession = {
      id: `call-${now.toString(36)}-${this.counter++}`,
      startedAt: now,
      lastSpeechAt: now,
      sttMode,
      ttsMode,
      ttsBaseUrl,
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
      watch: {
        on: false,
        cameras: [],
        frames: {},
        hashes: {},
        sizes: {},
        lastAmbientAt: 0,
        lastFrameAt: 0,
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
        { baseUrl: session.ttsBaseUrl, model: config.ttsModel, voice: config.ttsVoice },
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
    ttsBaseUrl: string;
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
    let ttsMode: VoiceEngine =
      config.ttsEngine === "endpoint" && !ttsOk ? "local" : config.ttsEngine;
    let ttsBaseUrl = config.ttsBaseUrl;
    // v0.17.2: the bundled mouth resolves through its
    // supervisor (see resolveBundledTts) — ready means the
    // call speaks Kokoro from the bundled engine; anything
    // else resolves to the app voice for this call with the
    // reason in the notice, exactly the endpoint discipline.
    let bundledNotice: string | undefined;
    if (config.ttsEngine === "bundled") {
      const resolved = await this.resolveBundledTts();
      if (resolved) {
        ttsMode = "bundled";
        ttsBaseUrl = resolved;
      } else {
        ttsMode = "local";
        bundledNotice = this.bundledNotice;
      }
    }
    const endpointFellBack =
      sttMode !== config.sttEngine ||
      (config.ttsEngine === "endpoint" && ttsMode !== config.ttsEngine);
    const speechNotice = bundledNotice
      ? endpointFellBack
        ? `${bundledNotice} The configured speech service was also unreachable.`
        : bundledNotice
      : endpointFellBack
        ? "Speech service unreachable — using built-in voice for this call."
        : undefined;
    return { sttMode, ttsMode, ttsBaseUrl, speechNotice };
  }

  /** The notice resolveBundledTts leaves when the bundled
   *  mouth can't take this call — set as a field because the
   *  reasons are several and the caller composes one notice. */
  private bundledNotice?: string;

  /** v0.17.2: resolve the bundled mouth for one call. Returns
   *  the loopback base URL to synthesize against when the
   *  bundled engine is up AND its model is ready AND the speech
   *  surface itself answers a probe; otherwise undefined, with
   *  bundledNotice saying which of those failed, in words the
   *  operator can act on. A model still downloading resolves to
   *  the app voice for this call rather than a call full of
   *  503s — the next call, after the download lands, speaks
   *  Kokoro. */
  private async resolveBundledTts(): Promise<string | undefined> {
    this.bundledNotice = undefined;
    if (!this.bundledTts) {
      this.bundledNotice =
        "Built-in Kokoro isn't available in this build — using the app voice for this call.";
      return undefined;
    }
    let status: BundledTtsStatus | undefined;
    try {
      status = await this.bundledTts.ensureRunning();
    } catch {
      status = undefined;
    }
    if (!status || !status.serverUp) {
      this.bundledNotice =
        "Built-in Kokoro is unavailable — using the app voice for this call." +
        (status?.detail ? ` (${status.detail})` : "");
      return undefined;
    }
    if (!status.modelReady) {
      this.bundledNotice = status.downloading
        ? `Built-in Kokoro is still downloading${status.progress !== null ? ` (${Math.floor(status.progress * 100)}%)` : ""} — using the app voice for this call.`
        : "Built-in Kokoro is still loading — using the app voice for this call.";
      return undefined;
    }
    const ok = await probeEndpoint(this.fetchFn, this.bundledTts.baseUrl, this.probeTimeoutMs);
    if (!ok) {
      this.bundledNotice = "Built-in Kokoro didn't answer — using the app voice for this call.";
      return undefined;
    }
    return this.bundledTts.baseUrl;
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
   *
   * v0.36.0: `images` carries an in-call camera photo turn's
   * pictures — the photo rides the SAME turn a transcript
   * takes (the chat photo's own door: the ordinary-job submit
   * into the ChannelHost, which re-validates, frames, and
   * delivers it as image input). The photos are shape-checked
   * HERE, synchronously, so an unusable photo refuses the
   * post itself with words the app can show — a photo is
   * never silently dropped. A photo with no words is a real
   * turn (the empty-transcript rule below applies only when
   * there are no photos either).
   */
  submitTranscript(
    sessionId: string,
    text: string,
    images?: unknown,
  ): { ok: boolean; detail: string } {
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
    let photos: MessageImage[] | undefined;
    if (images !== undefined) {
      const clean = sanitizeVoiceImages(images);
      if (clean === undefined) {
        return {
          ok: false,
          detail: "One of the attached photos isn't a usable image — nothing was sent.",
        };
      }
      if (clean.length) photos = clean;
    }
    session.lastSpeechAt = this.now();
    const postedAt = this.now();
    const trimmed = text.trim();
    session.chain = session.chain.then(() =>
      this.runTranscriptTurn(session, trimmed, postedAt, photos),
    );
    return { ok: true, detail: "Heard." };
  }

  // ------------------------------------------------------------ Watch mode (v0.37.0)

  /**
   * Watch on/off, from the app's per-call toggle. Turning it
   * on names the cameras the app is about to stream (its
   * mode: front, back, or both); a re-post while already on
   * just updates that list (a flip mid-watch). Turning it off
   * DROPS the held frames whole — the eyes close and nothing
   * of what they saw remains anywhere. Both events land in
   * the durable call record (voice-turns.jsonl, as watch
   * events — the transcript's own trace that the camera was
   * on, and when). Watch never turns itself on here: the only
   * way in is this call, from the operator's tap.
   */
  submitWatch(
    sessionId: string,
    on: boolean,
    cameras?: unknown,
  ): { ok: boolean; detail: string } {
    const session = this.session;
    if (!session || session.id !== sessionId) {
      return { ok: false, detail: "No live call by that id — nothing was changed." };
    }
    this.tick();
    if (this.session !== session) {
      return { ok: false, detail: "The call ended (timeout) as that arrived — nothing was changed." };
    }
    const cams: WatchCamera[] = [];
    if (Array.isArray(cameras)) {
      for (const c of cameras) {
        if ((c === "front" || c === "back") && !cams.includes(c)) cams.push(c);
      }
    }
    if (on) {
      const wasOn = session.watch.on;
      session.watch.on = true;
      session.watch.cameras = cams;
      if (!wasOn) {
        this.appendWatchEvent(
          session,
          `Watch turned on (${cams.length ? cams.join(" + ") : "camera"}). Frames are held in memory only and dropped when Watch turns off or the call ends.`,
        );
      }
      return {
        ok: true,
        detail: "Watching — the camera's frames now ride this call's turns, held in memory only.",
      };
    }
    if (session.watch.on) {
      session.watch.on = false;
      session.watch.cameras = [];
      session.watch.frames = {};
      session.watch.hashes = {};
      session.watch.sizes = {};
      session.watch.consumed = undefined;
      this.appendWatchEvent(session, "Watch turned off — the held frames were dropped.");
    }
    return { ok: true, detail: "Watch off — the held frames were dropped." };
  }

  /**
   * One Watch frame from the app: the session's new eyes for
   * one camera. The frame is shape-checked HERE, synchronously,
   * like a photo turn's — an unusable frame refuses the post
   * with words, never a silent drop. A frame that arrives
   * while Watch is off is refused and kept nowhere: the
   * camera being on is the operator's explicit act, and a
   * frame outside it is not this service's to hold.
   *
   * A stored frame does three things: it becomes the eyes the
   * NEXT turn (spoken, typed, or photo) is answered with; it
   * refreshes the call's watch activity (a watched call is
   * not idle — see tick); and, unless the app marked it a
   * turn refresh (the fresh frame grabbed the moment the
   * operator finished speaking, whose turn is already coming),
   * it may queue ONE ambient observation when the view has
   * materially changed since the last turn consumed it
   * (maybeQueueAmbient).
   */
  submitWatchFrame(
    sessionId: string,
    camera: string,
    image: unknown,
    hash?: unknown,
    turnRefresh?: boolean,
  ): { ok: boolean; detail: string } {
    const session = this.session;
    if (!session || session.id !== sessionId) {
      return { ok: false, detail: "No live call by that id — the frame was dropped, nothing was kept." };
    }
    this.tick();
    if (this.session !== session) {
      return { ok: false, detail: "The call ended (timeout) as that frame arrived — it was dropped." };
    }
    if (camera !== "front" && camera !== "back") {
      return { ok: false, detail: "That frame names a camera this call doesn't have — it was dropped." };
    }
    const clean = sanitizeVoiceImages([image]);
    if (!clean || clean.length === 0) {
      return { ok: false, detail: "That frame isn't a usable image — it was dropped, nothing was kept." };
    }
    if (!session.watch.on) {
      return { ok: false, detail: "Watch is off for this call — the frame was dropped, nothing was kept." };
    }
    const cam = camera as WatchCamera;
    session.watch.frames[cam] = clean[0];
    if (typeof hash === "string" && hash.length > 0) {
      session.watch.hashes[cam] = hash.toLowerCase();
    } else {
      delete session.watch.hashes[cam];
    }
    session.watch.sizes[cam] = clean[0].data.length;
    session.watch.lastFrameAt = this.now();
    if (!session.watch.cameras.includes(cam)) session.watch.cameras.push(cam);
    if (!turnRefresh) this.maybeQueueAmbient(session);
    return { ok: true, detail: "Frame received — it is the call's current view, held in memory only." };
  }

  /** The session's current eyes, in a fixed order (front,
   *  then back) — the frames the next turn is answered with.
   *  Empty unless Watch is on and at least one frame has
   *  arrived. */
  private watchEyes(session: ActiveSession): MessageImage[] {
    if (!session.watch.on) return [];
    const out: MessageImage[] = [];
    if (session.watch.frames.front) out.push(session.watch.frames.front);
    if (session.watch.frames.back) out.push(session.watch.frames.back);
    return out;
  }

  /** The current frame set's change fingerprint (hashes +
   *  sizes, never the frames). */
  private watchSnapshot(session: ActiveSession): WatchFrameSet {
    return {
      hashes: { ...session.watch.hashes },
      sizes: { ...session.watch.sizes },
    };
  }

  /**
   * Attach the session's eyes to a turn about to run: the
   * operator's own submitted images first (a deliberate send
   * outranks the ambient view), then the eyes, capped at one
   * turn's image limit. When at least one eye rides, the set
   * becomes the change baseline — a turn that saw the view
   * consumes it, so no ambient observation fires later for a
   * view a turn already answered with — and the turn is
   * marked liveView for the host's framing.
   */
  private attachWatchEyes(
    session: ActiveSession,
    submitted?: MessageImage[],
  ): { images?: MessageImage[]; liveView: boolean } {
    const eyes = this.watchEyes(session);
    if (!eyes.length) return { images: submitted, liveView: false };
    const base = submitted ?? [];
    const merged = [...base, ...eyes].slice(0, MAX_VOICE_IMAGES);
    const eyesRode = merged.length > base.length;
    if (eyesRode) session.watch.consumed = this.watchSnapshot(session);
    return { images: merged, liveView: eyesRode };
  }

  /**
   * The ambient gate (v0.37.0): queue an observation turn for
   * the frame that just arrived ONLY when all of these hold —
   * Watch is on; no approval is parked for the voice
   * conversation (the park owns the floor; the camera does
   * not start a turn over it); the rate limit's interval has
   * passed since the last QUEUED observation; and the view
   * materially changed since the last turn consumed it. Any
   * failure is a silent refresh — the frame still became the
   * session's eyes; it just isn't worth interrupting for.
   */
  private maybeQueueAmbient(session: ActiveSession): void {
    if (!session.watch.on) return;
    if (this.approvals.pendingFor(VOICE_CONVERSATION)) return;
    if (this.now() - session.watch.lastAmbientAt < WATCH_AMBIENT_MIN_INTERVAL_MS) return;
    if (!watchSetChanged(session.watch.consumed, this.watchSnapshot(session))) return;
    session.watch.lastAmbientAt = this.now();
    const postedAt = this.now();
    session.chain = session.chain.then(() => this.runWatchObservation(session, postedAt));
  }

  /**
   * One ambient Watch observation (v0.37.0): the fixed
   * observation instruction takes a turn on the serial chain,
   * with the session's CURRENT eyes attached (by the time the
   * chain reaches it, a newer frame may have arrived — the
   * look is at the view as it is, not as it was when queued).
   * Everything after that is completeTurn, verbatim: the same
   * job pipeline, the same spoken reply — with two deliberate
   * differences, both passed as options: no spoken filler (a
   * look that takes a while must not announce "Just a
   * second." to a quiet room), and the nothing-to-report
   * sentinel withholds the reply from the mouth entirely.
   * The turn carries no transcript — nobody spoke — and is
   * marked `watch` on the record. A park that appeared since
   * queueing, or Watch turned off in the meantime, settles
   * the look without a turn: the moment passed.
   */
  private async runWatchObservation(
    session: ActiveSession,
    postedAt: number,
  ): Promise<void> {
    if (this.session !== session) return;
    if (!session.watch.on) return;
    if (this.approvals.pendingFor(VOICE_CONVERSATION)) return;
    const eyes = this.watchEyes(session);
    if (!eyes.length) return;
    session.processing = true;
    const turn: VoiceSessionTurn = {
      index: session.turns.length,
      startedAt: this.now(),
      kind: "unavailable",
      detail: "",
      interrupted: false,
      watch: true,
    };
    session.turns.push(turn);
    try {
      const config = loadVoiceConfig(this.stateDir);
      if (!config.enabled || !voiceConfigured(config)) {
        turn.detail =
          "Voice was turned off or unconfigured in Settings mid-call — the call ended and that look went nowhere.";
        this.finish(session, "disabled");
        return;
      }
      session.watch.consumed = this.watchSnapshot(session);
      await this.completeTurn(session, turn, config, WATCH_OBSERVATION_TEXT, postedAt, 0, eyes, {
        liveView: true,
        silentReply: WATCH_NOTHING_TO_REPORT,
      });
      // Which ears the call had is a fact about the session,
      // recorded like any turn's — set after completeTurn so
      // its "(Built-in transcription…)" suffix, which is
      // about transcripts, never claims this look was one.
      // (The look itself is named on the detail by
      // completeTurn's live-view note, and by the `watch`
      // flag on this record.)
      turn.via = session.sttMode;
    } finally {
      this.appendTurnRecord(turn);
      session.processing = false;
    }
  }

  /**
   * A Watch event's line in the durable call record
   * (v0.37.0): voice-turns.jsonl gains {kind: "watch"} lines
   * beside the turn records — the transcript's own trace
   * that the camera was on and when it went off, in the same
   * best-effort discipline as appendTurnRecord (evidence,
   * never machinery). No frame data, no hashes: that the
   * camera was on is the record; what it saw is not.
   */
  private appendWatchEvent(session: ActiveSession, detail: string): void {
    try {
      appendFileSync(
        join(this.stateDir, "voice-turns.jsonl"),
        JSON.stringify({ ts: this.now(), session: session.id, kind: "watch", detail }) + "\n",
      );
    } catch {
      /* a lost line loses a clue, never a call */
    }
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
        watch: { on: session.watch.on, cameras: session.watch.cameras },
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
    // v0.37.0: a watched call whose frames keep arriving is
    // not idle — the operator turned the camera on and the
    // watching IS the activity (the 60-minute cap still ends
    // it). When frames stop (the app backgrounded, Watch
    // turned off), the ordinary silence rule resumes from
    // the last frame.
    const watchActive =
      session.watch.on &&
      session.watch.lastFrameAt > 0 &&
      now - session.watch.lastFrameAt < this.idleTimeoutMs;
    if (!busy && !watchActive && now - session.lastSpeechAt >= this.idleTimeoutMs) {
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

      // v0.37.0: the session's eyes ride the turn — the
      // answer is grounded in what the camera sees as the
      // operator finishes speaking.
      const eyesTurn = this.attachWatchEyes(session, undefined);
      await this.completeTurn(session, turn, config, transcript, utteranceEndAt, sttMs, eyesTurn.images, {
        liveView: eyesTurn.liveView,
      });
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
    images?: MessageImage[],
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
      if (!transcript && !images?.length) {
        // Loud, on the record, and nowhere else: an empty final
        // from the recognizer is a settled turn that never
        // becomes a job, a scan, or a reply.
        turn.detail =
          "The built-in recognizer handed over an empty transcript — nothing was sent to GUS.";
        return;
      }
      // v0.36.0: a photo turn's record carries the photo
      // COUNT (never the data), and a photo-only turn leaves
      // the transcript unset — the operator sent a picture,
      // not words, and the record says exactly that.
      if (images?.length) turn.photos = images.length;
      if (transcript) turn.transcript = transcript;
      // v0.37.0: the session's eyes ride the turn beside any
      // photos the operator sent — the answer is grounded in
      // what the camera sees right now. The record's photo
      // count above stays the OPERATOR's photos only: the
      // eyes are not something they sent, and the turn's
      // detail (completeTurn) names the live view instead.
      const eyesTurn = this.attachWatchEyes(session, images);
      await this.completeTurn(session, turn, config, transcript, postedAt, 0, eyesTurn.images, {
        liveView: eyesTurn.liveView,
      });
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
    images?: MessageImage[],
    opts?: { liveView?: boolean; silentReply?: string },
  ): Promise<void> {
    const jobStart = this.now();
    // v0.9.8: arm the spoken filler — if the job is still
    // running when the delay elapses, ONE "Just a second." is
    // queued through the segment path (queueFiller). Disarming
    // the moment the reply lands is what keeps a fast turn
    // filler-free.
    // v0.37.0: a turn that may be silenced (an ambient Watch
    // observation) arms NO filler — a look that takes a while
    // must not announce itself to a quiet room it may end up
    // saying nothing to.
    const filler = opts?.silentReply
      ? { disarm: () => {} }
      : this.armFiller(session, turn, config);
    let result: VoiceCallResult;
    try {
      result = await this.calls.processTranscript(transcript, images, {
        liveView: opts?.liveView === true,
      });
    } finally {
      filler.disarm();
    }
    // v0.37.0: the silent reply — an ambient observation whose
    // answer is the nothing-to-report sentinel is recorded
    // (the look happened; the record says so) but never
    // spoken: the reply text is withheld here, before the
    // mouth below can queue a single segment of it.
    const silenced =
      opts?.silentReply !== undefined && result.replyText?.trim() === opts.silentReply;
    if (silenced) result = { ...result, replyText: undefined };
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
    // v0.37.0: a turn that carried the camera's live view
    // says so on its record — the view itself is never
    // recorded, but that the answer was grounded in it is a
    // fact about the turn. A silenced observation says what
    // happened to its reply, in words.
    if (opts?.liveView && images?.length) {
      turn.detail += " (Watch: the call camera's live view rode this turn.)";
    }
    if (silenced) {
      turn.detail += " (Watch: the model looked and had nothing worth saying — nothing was spoken.)";
    }
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
        { baseUrl: session.ttsBaseUrl, model: config.ttsModel, voice: config.ttsVoice },
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
        /** v0.36.0: photo count for a camera turn — the
         *  count is the record, never the image data. */
        photos?: number;
        /** v0.37.0: present (and true) only on an ambient
         *  Watch observation turn — the look is the record;
         *  what the camera saw is never written here. */
        watch?: boolean;
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
        ...(turn.photos !== undefined ? { photos: turn.photos } : {}),
        ...(turn.watch ? { watch: true } : {}),
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
            { baseUrl: session.ttsBaseUrl, model: config.ttsModel, voice: config.ttsVoice },
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
    // v0.37.0: the eyes close with the call — the held frames
    // are dropped here, explicitly, so no path out of a call
    // (operator, timeout, kill phrase, disable) leaves a
    // frame held. The snapshot below carries turns and the
    // watch summary only; frames were never part of it.
    session.watch.on = false;
    session.watch.cameras = [];
    session.watch.frames = {};
    session.watch.hashes = {};
    session.watch.sizes = {};
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
      watch: { on: false, cameras: [] },
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
