/**
 * Channel resolution — the Phase 8 first-run deadlock fix.
 *
 * Field bug (2026-11-05): main.ts threw at startup when
 * GUS_CHANNEL=telegram had no bot token yet, BEFORE the setup panel
 * bound. Under the Mac app's launchd KeepAlive the control plane
 * crash-looped, 127.0.0.1:8731 never answered, and the setup wizard —
 * the only place a first-run user stores the token — was unreachable.
 *
 * What is pinned here:
 *  - telegram + no token anywhere RESOLVES (never throws) to the
 *    unconfigured stand-in, reads the vault exactly once for
 *    "telegram-bot", and logs exactly one warning that names the fix
 *    (store the secret via the panel, then restart).
 *  - The unconfigured adapter starts cleanly, emits no events, and
 *    its send path records the message as NOT delivered at error
 *    level instead of throwing or pretending delivery — throwing
 *    would crash the control plane via ChannelHost's `void` sends
 *    on the first parked approval.
 *  - A token selects the live path exactly as before: env wins (the
 *    vault is never even read), otherwise the vault value is used;
 *    either way a TelegramAdapter named "telegram".
 *  - The fake-file harness resolution is unchanged and never touches
 *    the vault.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChannelEvent } from "../../packages/shared/src/index.js";
// Imported by package name on purpose: channel-setup.ts imports
// "@gus/telegram", and instanceof only holds against the very class
// object the resolver constructed with — a relative import here
// would load the test-compiled second copy of the class.
import { TelegramAdapter } from "@gus/telegram";
import {
  UnconfiguredChannelAdapter,
  resolveChannelAdapter,
  type ChannelLogLevel,
} from "../../packages/control-plane/src/channel-setup.js";

interface LogLine {
  level: ChannelLogLevel;
  text: string;
}

function captureLog(): { lines: LogLine[]; log: (level: ChannelLogLevel, text: string) => void } {
  const lines: LogLine[] = [];
  return { lines, log: (level, text) => lines.push({ level, text }) };
}

const FAKE_TOKEN = "123456789:AAFakeTokenForResolutionTestsOnly000";

test("telegram with no token resolves unconfigured instead of throwing", () => {
  const { lines, log } = captureLog();
  const vaultReads: string[] = [];
  const res = resolveChannelAdapter({
    channelKind: "telegram",
    readVaultSecret: (name) => {
      vaultReads.push(name);
      return undefined;
    },
    log,
  });
  assert.equal(res.mode, "unconfigured");
  assert.ok(res.adapter instanceof UnconfiguredChannelAdapter);
  assert.equal(res.adapter.name, "unconfigured");
  assert.deepEqual(vaultReads, ["telegram-bot"]);
  const warnings = lines.filter((l) => l.level === "warn");
  assert.equal(warnings.length, 1, "exactly one warning line is logged");
  assert.match(warnings[0]!.text, /NOT configured/);
  assert.match(warnings[0]!.text, /"telegram-bot"/);
  assert.match(warnings[0]!.text, /setup wizard/);
  assert.match(warnings[0]!.text, /restart the control plane/);
  assert.equal(res.warning, warnings[0]!.text);
});

test("unconfigured adapter: silent start, send fails loudly in the log, never throws", async () => {
  const { lines, log } = captureLog();
  const adapter = new UnconfiguredChannelAdapter(log);
  const events: ChannelEvent[] = [];
  await adapter.start((ev) => events.push(ev));
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(events.length, 0, "no transport means no inbound events, ever");
  await adapter.send({ conversationId: "4242", text: "⏸ Job parked — approval needed" });
  const errors = lines.filter((l) => l.level === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.text, /NOT delivered/);
  assert.match(errors[0]!.text, /conversation=4242/);
  await adapter.stop();
});

test("env token selects the live Telegram adapter; the vault is never read", () => {
  const { lines, log } = captureLog();
  let vaultRead = false;
  const res = resolveChannelAdapter({
    channelKind: "telegram",
    envToken: FAKE_TOKEN,
    readVaultSecret: () => {
      vaultRead = true;
      return "999999999:BBShouldNeverBeUsedEnvWins00000000";
    },
    log,
  });
  assert.equal(res.mode, "telegram");
  assert.ok(res.adapter instanceof TelegramAdapter);
  assert.equal(res.adapter.name, "telegram");
  assert.equal(res.warning, undefined);
  assert.equal(vaultRead, false, "env token short-circuits the vault, as before");
  assert.equal(lines.length, 0, "nothing is logged on the configured path");
});

test("vault token (no env) selects the live Telegram adapter", () => {
  const res = resolveChannelAdapter({
    channelKind: "telegram",
    readVaultSecret: (name) => (name === "telegram-bot" ? FAKE_TOKEN : undefined),
    log: () => {
      throw new Error("the configured path must not log");
    },
  });
  assert.equal(res.mode, "telegram");
  assert.ok(res.adapter instanceof TelegramAdapter);
  assert.equal(res.adapter.name, "telegram");
});

test("fake-file channel still resolves to the harness adapter, vault untouched", () => {
  const res = resolveChannelAdapter({
    channelKind: "fake-file",
    fakeInbound: "/tmp/gus-test-inbound.ndjson",
    fakeOutbound: "/tmp/gus-test-outbound.ndjson",
    readVaultSecret: () => {
      throw new Error("the vault must not be read for the fake-file channel");
    },
    log: () => {},
  });
  assert.equal(res.mode, "fake-file");
  assert.ok(res.adapter instanceof TelegramAdapter);
  assert.equal(res.adapter.name, "telegram");
  assert.equal(res.warning, undefined);
});
