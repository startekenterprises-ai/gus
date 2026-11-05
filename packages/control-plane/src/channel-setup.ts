/**
 * Channel resolution for the control plane (extracted from main.ts so
 * the startup rule is testable).
 *
 * The first-run rule (Phase 8 field bug, 2026-11-05): when
 * GUS_CHANNEL=telegram and no bot token exists yet — neither the
 * GUS_TELEGRAM_BOT_TOKEN env var nor the "telegram-bot" vault secret
 * the setup wizard stores — startup must NOT throw. The old code
 * threw before the setup panel bound, and the Mac app's launchd agent
 * (KeepAlive=true) crash-looped the control plane forever: the panel
 * at 127.0.0.1:8731 is the very place a first-run user stores the
 * token, so a fresh install could never onboard. Now startup
 * continues with an UnconfiguredChannelAdapter plus one loud warning;
 * storing the token via the wizard and restarting brings Telegram
 * live. When a token IS present, resolution is exactly what it was:
 * env wins, the vault is the fallback, and the adapter is a
 * TelegramAdapter over BotApiTransport.
 *
 * Approval discipline is unchanged by the missing channel: approvals
 * park in the Approval Engine as usual, resolution happens ONLY in
 * ChannelHost (channel buttons/commands when a channel exists, the
 * operator panel always), and timeout still means deny. The
 * unconfigured adapter delivers nothing — every send is recorded in
 * the log as undelivered, never silently dropped and never faked as
 * sent.
 */
import type { ChannelAdapter, ChannelEvent, OutboundMessage } from "@gus/shared";
import { BotApiTransport, FakeFileTransport, TelegramAdapter } from "@gus/telegram";
import { TELEGRAM_SECRET_NAME } from "./onboarding.js";

export type ChannelLogLevel = "info" | "warn" | "error";
export type ChannelLog = (level: ChannelLogLevel, text: string) => void;

/**
 * The stand-in adapter for channel=telegram with no token yet. It
 * satisfies ChannelHost's adapter contract without a transport:
 * start() resolves immediately and no event can ever arrive (there is
 * nothing to receive from), and send() fails loudly in the log.
 *
 * send() must NOT throw: ChannelHost fires several sends as `void`
 * promises (the approval-parked notice above all) and this process
 * has no unhandled-rejection handler, so a throw here would crash
 * the control plane on the first parked approval — the same crash
 * loop this adapter exists to end, through another door. Logging the
 * failure at error level IS the failure surface; the approval itself
 * is unaffected, because it lives in the Approval Engine and resolves
 * only through ChannelHost.
 */
export class UnconfiguredChannelAdapter implements ChannelAdapter {
  readonly name = "unconfigured";

  constructor(private log: ChannelLog) {}

  async start(_onEvent: (ev: ChannelEvent) => void): Promise<void> {
    // No transport exists, so no event can ever arrive. Resolving
    // immediately is the honest shape: the host starts normally and
    // the missing channel stays visible in the log, not hidden.
  }

  async stop(): Promise<void> {}

  async send(msg: OutboundMessage): Promise<void> {
    this.log(
      "error",
      `channel send NOT delivered — no channel is configured (conversation=${msg.conversationId}). ` +
        `The message was not sent anywhere; it is recorded here so the failure is loud, not silent. ` +
        `Store the "${TELEGRAM_SECRET_NAME}" secret via the setup panel and restart the control plane to enable Telegram.`,
    );
  }

  async ackButton(callbackId: string): Promise<void> {
    this.log(
      "error",
      `channel ackButton NOT delivered — no channel is configured (callback=${callbackId}).`,
    );
  }
}

export interface ChannelResolution {
  adapter: ChannelAdapter;
  /** How startup resolved the channel: a live Telegram adapter, the
   *  fake-file harness adapter, or the unconfigured stand-in. */
  mode: "telegram" | "fake-file" | "unconfigured";
  /** Set only in "unconfigured" mode: the warning that was logged. */
  warning?: string;
}

export interface ChannelSetupOptions {
  /** GUS_CHANNEL ("fake-file" | "telegram"). */
  channelKind: string;
  /** GUS_TELEGRAM_BOT_TOKEN, when set. Wins over the vault. */
  envToken?: string;
  /** GUS_FAKE_INBOUND / GUS_FAKE_OUTBOUND (fake-file harness only). */
  fakeInbound?: string;
  fakeOutbound?: string;
  /** Reads a vault secret's value. Control-plane only; the value is
   *  used for the transport and never printed or logged. Consulted
   *  ONLY for channel=telegram with no env token. */
  readVaultSecret: (name: string) => string | undefined | null;
  log: ChannelLog;
}

export function resolveChannelAdapter(opts: ChannelSetupOptions): ChannelResolution {
  if (opts.channelKind === "telegram") {
    // Phase 4 rule, unchanged: env wins; the vault value (stored by
    // the panel's setup wizard) is read once at boot otherwise. An
    // empty env value is no token at all, so the vault still gets
    // its say — the pre-fix code threw on that case instead.
    const token = opts.envToken || opts.readVaultSecret(TELEGRAM_SECRET_NAME) || undefined;
    if (token) {
      return { adapter: new TelegramAdapter(new BotApiTransport(token)), mode: "telegram" };
    }
    const warning =
      `telegram channel is NOT configured — no bot token found ` +
      `(GUS_TELEGRAM_BOT_TOKEN is unset and the vault has no "${TELEGRAM_SECRET_NAME}" secret). ` +
      `The setup panel is up: store the "${TELEGRAM_SECRET_NAME}" secret in the setup wizard, ` +
      `then restart the control plane to enable the Telegram channel. ` +
      `Until then the control plane runs WITHOUT a live channel: jobs, spend caps, the Shield gate ` +
      `and the panel work as usual, approvals park as usual and can be resolved from the panel, ` +
      `and outbound channel messages are logged as undeliverable — never sent, never silently dropped.`;
    opts.log("warn", warning);
    return { adapter: new UnconfiguredChannelAdapter(opts.log), mode: "unconfigured", warning };
  }
  const inbound = opts.fakeInbound ?? "/run/gus/inbound.ndjson";
  const outbound = opts.fakeOutbound ?? "/run/gus/outbound.ndjson";
  return { adapter: new TelegramAdapter(new FakeFileTransport(inbound, outbound)), mode: "fake-file" };
}
