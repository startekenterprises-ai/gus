/**
 * The voice channel (v0.9) — "Call GUS": the operator talks, GUS
 * answers out loud, and nothing about the conversation is special
 * once the words exist.
 *
 * The shape follows the panel Chat adapter (v0.6) exactly, because
 * that shape is the security argument: the voice channel is one
 * more ChannelAdapter ("voice", one conversation), and a
 * transcript becomes an ordinary inbound message event into the
 * ChannelHost — where the ingress secret-guard, the sender gate,
 * the Agent-Shield ingress scan, the classifier, the Governor
 * caps, and the receipt chain all apply, unchanged. Voice gets NO
 * bypass: a prompt injection spoken aloud is scanned and blocked
 * exactly like one typed into Telegram, and a voice job settles
 * with the same receipts.
 *
 * What voice adds, and only this:
 *   - Ears: the transcript comes from the operator's local STT
 *     service (speech.ts) instead of a keyboard.
 *   - A mouth: the host's delivery to this conversation is
 *     captured by send() and handed to the call service, which
 *     synthesizes it with the operator's local TTS service for
 *     the app to play.
 *   - Speech acts (phrases.ts): a kill phrase becomes the typed
 *     /stop command; while an approval is parked for this
 *     conversation, an exact confirm/deny phrase becomes the
 *     typed /approve <id> or /deny <id> command. The read-back
 *     IS the host's park notice — the summary the operator hears
 *     is the summary the hash-bound record holds — plus the
 *     spoken instruction naming the phrases that count. Voice
 *     never approves silently, never resolves by button-forge,
 *     and an ambiguous answer executes nothing.
 *
 * The 0.9.0 call was request/response (push-to-talk in the app):
 * one utterance in, the FIRST host delivery back (a result, a
 * block notice, a park read-back, a cap notice) spoken back.
 * Later deliveries for a still-running job are not lost to the
 * record — the job and its receipts live in the panel like any
 * other — but they are not held for a call that already ended;
 * the adapter drops stale deliveries at the next call's start,
 * the way a phone call drops a sentence spoken after hang-up.
 *
 * v0.9.1: the live call (session.ts) reuses exactly this turn
 * logic through processTranscript() — one transcript in, one
 * settled turn out — and differs only in the ears (a streamed,
 * segmented utterance instead of one recording) and the mouth
 * (sentence-streamed speech instead of one synthesis). The
 * pipeline the words travel is the same one, because that
 * sameness is the security argument.
 */
import type {
  ChannelAdapter,
  ChannelEvent,
  OutboundMessage,
} from "@gus/shared";
import {
  loadVoiceConfig,
  voiceConfigured,
  type VoiceConfig,
} from "./config.js";
import { classifyTranscript, CONFIRM_INSTRUCTION } from "./phrases.js";
import {
  synthesize,
  transcribe,
  SpeechServiceError,
  type FetchFn,
} from "./speech.js";

export const VOICE_CONVERSATION = "voice";
export const VOICE_SENDER = "voice";

export type VoiceCallKind =
  /** A normal utterance became a job and the host answered. */
  | "reply"
  /** Submitted, but no delivery arrived inside the wait — the
   *  job still runs and will settle in the panel as usual. */
  | "pending"
  /** The utterance was a kill phrase; /stop ran. */
  | "stopped"
  /** The utterance resolved the parked approval. */
  | "approval-resolved"
  /** An approval is parked and the utterance was not a clear
   *  confirm or deny — nothing ran; a clear answer is still
   *  needed. */
  | "awaiting-confirmation"
  /** Voice is off, unconfigured, or a speech service failed —
   *  detail says which, loudly. Nothing reached GUS unless the
   *  failure was TTS (the reply then rides along as text). */
  | "unavailable";

export interface VoiceCallResult {
  ok: boolean;
  kind: VoiceCallKind;
  detail: string;
  transcript?: string;
  replyText?: string;
  audioBase64?: string;
  audioContentType?: string;
}

/** The pending-approval lookup the service needs — the control
 *  plane wires it to the Approval Engine; declared here so this
 *  package never imports the engine. */
export interface PendingApprovalLookup {
  pendingFor(conversationId: string): { id: string; summary: string } | undefined;
}

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;

interface Waiter {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class VoiceAdapter implements ChannelAdapter {
  readonly name = "voice";
  private onEvent?: (ev: ChannelEvent) => void;
  private counter = 0;
  private outQueue: string[] = [];
  private waiters: Waiter[] = [];

  async start(onEvent: (ev: ChannelEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  async stop(): Promise<void> {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve("");
    }
  }

  /**
   * Submit text as an inbound voice-conversation message — the
   * composer's send button, mirrored from PanelChatAdapter: from
   * the emit on, the pipeline cannot tell the words were spoken.
   * Control utterances arrive here already translated by the call
   * service ("/stop", "/approve <id>", "/deny <id>") and take the
   * host's existing command paths verbatim.
   */
  submit(text: string): { ok: boolean; detail: string } {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, detail: "Nothing was heard — nothing was sent." };
    if (!this.onEvent) {
      return { ok: false, detail: "The voice channel is not running yet — nothing was sent." };
    }
    this.onEvent({
      type: "message",
      message: {
        conversationId: VOICE_CONVERSATION,
        messageId: `voice-${Date.now().toString(36)}-${this.counter++}`,
        senderId: VOICE_SENDER,
        text: trimmed,
        receivedAt: Date.now(),
      },
    });
    return { ok: true, detail: "Sent." };
  }

  /** Outbound: the host has already egress-screened this text.
   *  Hand it to the waiting call, or queue it as the next call's
   *  first delivery. Buttons are meaningless here — the panel
   *  renders approval cards from the engine, and voice resolves
   *  by spoken command; the text carries everything. */
  async send(msg: OutboundMessage): Promise<void> {
    if (msg.conversationId !== VOICE_CONVERSATION) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg.text);
    } else {
      this.outQueue.push(msg.text);
    }
  }

  /** Drop deliveries that arrived while no call was listening —
   *  called at the start of each call so a stale notice is never
   *  mistaken for this utterance's reply. */
  drainStale(): void {
    this.outQueue.length = 0;
  }

  /** The next delivery for this conversation, or undefined when
   *  none arrives inside the timeout. */
  waitForReply(timeoutMs: number): Promise<string | undefined> {
    const queued = this.outQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (text) => resolve(text === "" ? undefined : text),
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(undefined);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

export class VoiceCallService {
  private fetchFn: FetchFn;
  private replyTimeoutMs: number;

  constructor(
    private stateDir: string,
    private adapter: VoiceAdapter,
    private approvals: PendingApprovalLookup,
    opts?: { fetchFn?: FetchFn; replyTimeoutMs?: number },
  ) {
    this.fetchFn = opts?.fetchFn ?? fetch;
    this.replyTimeoutMs = opts?.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  }

  /** The settings readout + save path ride on the same file the
   *  service reads per call. */
  config(): VoiceConfig {
    return loadVoiceConfig(this.stateDir);
  }

  /**
   * One push-to-talk exchange: audio in, spoken reply out.
   * Every failure is a returned { ok: false } with the reason in
   * the detail — loud, specific, and with nothing silently
   * substituted.
   */
  async handleAudio(audio: Uint8Array, contentType: string): Promise<VoiceCallResult> {
    const config = this.config();
    if (!config.enabled) {
      return {
        ok: false,
        kind: "unavailable",
        detail:
          "Voice is off. Enable it in Settings → Voice and point it at your transcription and speech services, then try again. Nothing was sent to GUS.",
      };
    }
    if (!voiceConfigured(config)) {
      return {
        ok: false,
        kind: "unavailable",
        detail:
          "Voice is enabled but an endpoint is missing from its settings. Nothing was sent to GUS — check Settings → Voice.",
      };
    }
    if (audio.length === 0) {
      return { ok: false, kind: "unavailable", detail: "The recording was empty — nothing was sent to GUS." };
    }
    if (audio.length > MAX_AUDIO_BYTES) {
      return {
        ok: false,
        kind: "unavailable",
        detail: `That recording is ${(audio.length / 1024 / 1024).toFixed(1)} MB — over the ${MAX_AUDIO_BYTES / 1024 / 1024} MB call limit. Nothing was sent to GUS.`,
      };
    }

    // --- ears -------------------------------------------------
    let transcript: string;
    try {
      transcript = await transcribe(
        this.fetchFn,
        { baseUrl: config.sttBaseUrl, model: config.sttModel },
        audio,
        contentType,
      );
    } catch (e) {
      return {
        ok: false,
        kind: "unavailable",
        detail: e instanceof SpeechServiceError ? e.message : `Transcription failed: ${String(e)}`,
      };
    }

    // --- the turn itself: identical for a push-to-talk call and
    // a live session; only the speaking differs (one synthesis
    // here, a sentence stream there). -----------------------------
    const turn = await this.processTranscript(transcript);
    return this.speak(config, turn);
  }

  /**
   * One settled turn from an existing transcript: speech acts
   * first (kill / confirm / deny against a parked approval), then
   * an ordinary job through the channel pipeline, waiting for the
   * host's first delivery. The result carries the reply TEXT and
   * no audio — how the text is spoken is the caller's business
   * (handleAudio synthesizes it whole; the live session streams
   * it sentence by sentence). Public within the package: the
   * session service is the second caller, not a second pipeline.
   */
  async processTranscript(transcript: string): Promise<VoiceCallResult> {
    this.adapter.drainStale();
    const phrase = classifyTranscript(transcript);
    const pending = this.approvals.pendingFor(VOICE_CONVERSATION);

    if (phrase.kind === "kill") {
      const sent = this.adapter.submit("/stop");
      if (!sent.ok) return { ok: false, kind: "unavailable", transcript, detail: sent.detail };
      const reply = await this.adapter.waitForReply(this.replyTimeoutMs);
      return {
        ok: true,
        kind: "stopped",
        detail: "Kill phrase heard — the stop command ran through the channel's normal /stop path.",
        transcript,
        replyText: reply ?? "Stopped. Kill switch is ON — say resume from any channel when you want me back.",
      };
    }

    if (pending) {
      if (phrase.kind === "confirm" || phrase.kind === "deny") {
        const sent = this.adapter.submit(
          phrase.kind === "confirm" ? `/approve ${pending.id}` : `/deny ${pending.id}`,
        );
        if (!sent.ok) return { ok: false, kind: "unavailable", transcript, detail: sent.detail };
        const reply = await this.adapter.waitForReply(this.replyTimeoutMs);
        return {
          ok: true,
          kind: "approval-resolved",
          detail:
            phrase.kind === "confirm"
              ? "Confirm phrase heard — the parked action was approved through the channel's normal /approve path."
              : "Deny phrase heard — the parked action was denied through the channel's normal /deny path.",
          transcript,
          replyText: reply ?? (phrase.kind === "confirm" ? "Approved." : "Denied. Nothing ran."),
        };
      }
      // Ambiguous (or a fresh request) while a park waits: the
      // park owns the floor. Nothing is submitted, nothing runs —
      // the operator hears the read-back again with the phrases
      // that count.
      return {
        ok: true,
        kind: "awaiting-confirmation",
        detail:
          "An approval is parked and that wasn't a clear confirm or deny, so nothing ran and nothing new was submitted.",
        transcript,
        replyText:
          `Still waiting on your call about this: "${pending.summary}". ` + CONFIRM_INSTRUCTION,
      };
    }

    // --- a normal job ------------------------------------------
    const sent = this.adapter.submit(transcript);
    if (!sent.ok) return { ok: false, kind: "unavailable", transcript, detail: sent.detail };
    const reply = await this.adapter.waitForReply(this.replyTimeoutMs);
    if (reply === undefined) {
      return {
        ok: true,
        kind: "pending",
        detail:
          "Submitted as a normal job, but no reply landed inside the call window — it keeps running and settles in the panel with its receipt, like any job.",
        transcript,
        replyText:
          "That's with me — it's taking longer than a call can wait, so I'll leave it running. The answer will be in the chat history when it lands.",
      };
    }
    // A park notice as the first delivery is the read-back: make
    // sure the spoken form carries the phrases that count, even
    // though the typed form (which names /approve) stays the
    // record other surfaces show.
    const replyText = reply.includes("Job parked")
      ? `${reply} For voice: ${CONFIRM_INSTRUCTION}`
      : reply;
    return {
      ok: true,
      kind: "reply",
      detail: "Heard, scanned, and answered through the normal job pipeline.",
      transcript,
      replyText,
    };
  }

  /** Synthesize the reply for playback. A TTS failure does NOT
   *  swallow the exchange: the result fails loudly (ok: false)
   *  and still carries the transcript + reply text, so the app
   *  can show what GUS said and exactly why it wasn't spoken. */
  private async speak(config: VoiceConfig, result: VoiceCallResult): Promise<VoiceCallResult> {
    if (!result.replyText) return result;
    try {
      const { audio, contentType } = await synthesize(
        this.fetchFn,
        { baseUrl: config.ttsBaseUrl, model: config.ttsModel, voice: config.ttsVoice },
        result.replyText,
      );
      return {
        ...result,
        audioBase64: Buffer.from(audio).toString("base64"),
        audioContentType: contentType,
      };
    } catch (e) {
      return {
        ...result,
        ok: false,
        detail:
          `${result.detail} ` +
          (e instanceof SpeechServiceError
            ? e.message
            : `Speech synthesis failed: ${String(e)}`),
      };
    }
  }
}
