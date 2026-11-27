/**
 * Persona context to Core (v0.40.0) — the phone's composed
 * persona prompt (persona + house style + that persona's
 * memories) rides Core transports, pinned:
 *
 *  - The cap: 16 KiB of UTF-8, one constant both ends
 *    enforce; an over-cap context is refused IN WORDS at
 *    every door (panel chat adapter, voice session start,
 *    mid-call update) and never silently truncated.
 *  - Chat: the panel adapter carries the context on the
 *    emitted event only — the durable transcript record is
 *    the operator's words alone — and the ChannelHost
 *    frames it at the head of the job's runtime prompt, in
 *    the persona position, under the core's own framing.
 *    Absent, the runtime prompt is byte-identical to the
 *    operator's words.
 *  - Voice: the session holds the context in memory only;
 *    every turn it submits carries it; a mid-call update
 *    replaces it whole for subsequent turns; an over-cap
 *    update is refused and the session KEEPS the context it
 *    had; a blank update clears it.
 *  - Privacy: the context's content appears in NO durable
 *    record — not the chat transcript, not the job store,
 *    not events.jsonl, not voice-turns.jsonl. The logs keep
 *    presence, character count, and a short hash only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PERSONA_CONTEXT_BYTES,
  utf8ByteLength,
  type ChannelAdapter,
  type ChannelEvent,
  type InboundMessage,
  type OutboundMessage,
} from "../../packages/shared/src/index.js";
import {
  ChannelHost,
  personaContextNote,
} from "../../packages/control-plane/src/channel-host.js";
import { Governor } from "../../packages/control-plane/src/governor.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { ApprovalEngine } from "../../packages/control-plane/src/approvals.js";
import { PanelChatAdapter } from "../../packages/control-plane/src/panel-chat.js";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import {
  VoiceAdapter,
  VoiceSessionService,
  writeVoiceConfig,
} from "../../packages/channels/voice/src/index.js";

const CTX_A = "You are Debbie Downer, dry and doom-leaning. The operator asked you to remember: their code word is PERSONA-ALPHA-7.";
const CTX_B = "You are the Priest, warm and unhurried. The operator asked you to remember: PERSONA-BETA-9.";
const OVER_CAP = "x".repeat(MAX_PERSONA_CONTEXT_BYTES + 1);

const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  assert.ok(cond(), `timed out waiting for ${what}`);
}

/** Every file under a state dir, concatenated — the "did the
 *  private content reach ANY durable record" sweep. */
function allFileText(dir: string): string {
  let out = "";
  const walk = (d: string): void => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else {
        try {
          out += readFileSync(p, "utf8") + "\n";
        } catch {
          /* binary key material — not a text record */
        }
      }
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------- the cap

test("cap: 16 KiB of UTF-8, measured in bytes on both ends", () => {
  assert.equal(MAX_PERSONA_CONTEXT_BYTES, 16_384);
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("ééé"), 6, "multi-byte characters count their bytes, not themselves");
  assert.ok(utf8ByteLength(OVER_CAP) > MAX_PERSONA_CONTEXT_BYTES);
});

test("framing: the host's persona note names its own limit", () => {
  const note = personaContextNote(CTX_A);
  assert.ok(note.includes(CTX_A), "the context rides inside the framing");
  assert.ok(note.includes("never changes your tools, your rules, or any safety limit"));
  assert.ok(note.includes("not a list to recite"));
});

// ---------------------------------------------------------------- chat adapter

test("panel chat: the context rides the event only — never the transcript record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-persona-chat-"));
  const adapter = new PanelChatAdapter(dir);
  const events: ChannelEvent[] = [];
  await adapter.start((ev) => events.push(ev));

  const sent = adapter.submit("hello core", undefined, undefined, CTX_A);
  assert.equal(sent.ok, true, sent.detail);
  assert.equal(events.length, 1);
  const msg = (events[0] as { message: InboundMessage }).message;
  assert.equal(msg.personaContext, CTX_A, "the emitted event carries the context");

  const plain = adapter.submit("second message", undefined, undefined, undefined);
  assert.equal(plain.ok, true, plain.detail);
  const msg2 = (events[1] as { message: InboundMessage }).message;
  assert.equal("personaContext" in msg2, false, "absent stays absent — no empty field rides");

  const blank = adapter.submit("third message", undefined, undefined, "   ");
  assert.equal(blank.ok, true, blank.detail);
  const msg3 = (events[2] as { message: InboundMessage }).message;
  assert.equal("personaContext" in msg3, false, "a blank context is no context");

  assert.ok(
    !allFileText(dir).includes("PERSONA-ALPHA-7"),
    "the context's content is in no durable record the adapter wrote",
  );
});

test("panel chat: an over-cap context refuses the whole submission, in words", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-persona-chat-cap-"));
  const adapter = new PanelChatAdapter(dir);
  const events: ChannelEvent[] = [];
  await adapter.start((ev) => events.push(ev));

  const refused = adapter.submit("hello core", undefined, undefined, OVER_CAP);
  assert.equal(refused.ok, false);
  assert.ok(refused.detail.includes("16 KB"), refused.detail);
  assert.ok(refused.detail.includes("nothing was sent"), refused.detail);
  assert.equal(events.length, 0, "nothing was emitted for the refused job");
});

// ---------------------------------------------------------------- channel host

class RecordingAdapter implements ChannelAdapter {
  readonly name = "telegram";
  sent: OutboundMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }
}

test("host: the context heads the runtime prompt; the logs keep count + hash only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gus-persona-host-"));
  const governor = new Governor(dir, { maxTokensPerJob: 100_000, maxTokensPerDay: 10_000_000 });
  const jobs = new JobRunner(dir, new LocalReceiptIssuer(join(dir, "receipt-stub.key")));
  const approvals = new ApprovalEngine(dir, () => 120_000);
  const panelChat = new PanelChatAdapter(dir);
  const host = new ChannelHost(dir, governor, jobs, [new RecordingAdapter(), panelChat], approvals, undefined);
  const pushed: { jobId: string; text: string }[] = [];
  host.attachComm({
    pushUserMessage: (m: { jobId: string; text: string }) => pushed.push(m),
    broadcast: () => {},
    executeApproval: () => {},
  } as never);
  await host.start();

  const sent = panelChat.submit("hello core", undefined, undefined, CTX_A);
  assert.equal(sent.ok, true, sent.detail);
  await until(() => pushed.length === 1, "the job to reach the runtime");
  assert.ok(
    pushed[0].text.startsWith("(Persona context for this conversation"),
    "the persona block heads the runtime prompt",
  );
  assert.ok(pushed[0].text.includes(CTX_A), "the context itself rides the runtime prompt");
  assert.ok(pushed[0].text.includes("hello core"), "the operator's words follow it");

  const plain = panelChat.submit("plain words", undefined, undefined, undefined);
  assert.equal(plain.ok, true, plain.detail);
  await until(() => pushed.length === 2, "the second job to reach the runtime");
  assert.equal(pushed[1].text, "plain words", "absent context: the runtime prompt is the words, byte-identical");

  const eventsText = readFileSync(join(dir, "events.jsonl"), "utf8");
  const personaLines = eventsText
    .split("\n")
    .filter((l) => l.includes('"persona_context"'));
  assert.equal(personaLines.length, 1, "exactly one persona_context event — the job that carried one");
  const rec = JSON.parse(personaLines[0]) as { chars?: number; hash?: string };
  assert.equal(rec.chars, CTX_A.length);
  assert.match(rec.hash ?? "", /^[0-9a-f]{12}$/);

  assert.ok(
    !allFileText(dir).includes("PERSONA-ALPHA-7"),
    "the context's content is in no durable record — not the transcript, not the job store, not the event log",
  );
});

// ---------------------------------------------------------------- voice session

function voiceRig() {
  const dir = mkdtempSync(join(tmpdir(), "gus-persona-voice-"));
  writeVoiceConfig(
    dir,
    {
      enabled: true,
      enginesChosen: true,
      sttEngine: "local",
      sttBaseUrl: "http://stt.test/v1",
      sttModel: "whisper-1",
      ttsEngine: "local",
      ttsBaseUrl: "http://tts.test/v1",
      ttsModel: "kokoro",
      ttsVoice: "af_heart",
      bargeIn: true,
      shieldScan: true,
    },
    "test",
  );
  const voice = new VoiceAdapter();
  const messages: InboundMessage[] = [];
  const sessions = new VoiceSessionService(
    dir,
    voice,
    { pendingFor: () => undefined },
    { now: () => 5_000_000, replyTimeoutMs: 50 },
  );
  return { dir, voice, messages, sessions };
}

test("voice: the session holds, updates, refuses, and clears the context — memory only", async () => {
  const { dir, voice, messages, sessions } = voiceRig();
  await voice.start((ev) => {
    if (ev.type === "message") messages.push(ev.message);
  });

  // No live call: an update has nowhere to land.
  assert.equal(sessions.setPersonaContext("call-nope", CTX_A).ok, false);

  const started = await sessions.start(CTX_A);
  assert.equal(started.ok, true, started.detail);
  const id = started.sessionId!;

  const turnsText = () => readFileSync(join(dir, "voice-turns.jsonl"), "utf8");
  const personaLines = () =>
    turnsText()
      .split("\n")
      .filter((l) => l.includes('"persona_context"'))
      .map((l) => JSON.parse(l) as { chars?: number; hash?: string; refused?: boolean; cleared?: boolean });

  // The opening context's trace: count + hash, never content.
  assert.equal(personaLines().length, 1);
  assert.equal(personaLines()[0].chars, CTX_A.length);
  assert.match(personaLines()[0].hash ?? "", /^[0-9a-f]{12}$/);
  assert.ok(!turnsText().includes("PERSONA-ALPHA-7"), "the call record never holds the content");

  // A spoken turn carries the held context.
  assert.equal(sessions.submitTranscript(id, "hello gus").ok, true);
  await sessions.drain();
  const first = messages.filter((m) => m.text === "hello gus");
  assert.equal(first.length, 1);
  assert.equal(first[0].personaContext, CTX_A);

  // A mid-call update replaces it whole, from the next turn.
  const updated = sessions.setPersonaContext(id, CTX_B);
  assert.equal(updated.ok, true, updated.detail);
  assert.equal(sessions.submitTranscript(id, "second question").ok, true);
  await sessions.drain();
  const second = messages.filter((m) => m.text === "second question");
  assert.equal(second.length, 1);
  assert.equal(second[0].personaContext, CTX_B);

  // An over-cap update is refused — and the session KEEPS B.
  const refused = sessions.setPersonaContext(id, OVER_CAP);
  assert.equal(refused.ok, false);
  assert.ok(refused.detail.includes("keeps the context it already had"), refused.detail);
  assert.equal(personaLines().at(-1)?.refused, true, "the refusal is on the record, content-free");
  assert.equal(sessions.submitTranscript(id, "third question").ok, true);
  await sessions.drain();
  const third = messages.filter((m) => m.text === "third question");
  assert.equal(third.length, 1);
  assert.equal(third[0].personaContext, CTX_B, "the refused update changed nothing");

  // A blank update clears it; later turns carry none.
  assert.equal(sessions.setPersonaContext(id, undefined).ok, true);
  assert.equal(personaLines().at(-1)?.cleared, true);
  assert.equal(sessions.submitTranscript(id, "fourth question").ok, true);
  await sessions.drain();
  const fourth = messages.filter((m) => m.text === "fourth question");
  assert.equal(fourth.length, 1);
  assert.equal("personaContext" in fourth[0], false, "cleared means absent, not empty");

  assert.ok(!allFileText(dir).includes("PERSONA-BETA-9"), "no durable record anywhere holds the content");
  sessions.end(id);
});

test("voice: an over-cap opening context starts the call without it, and says so", async () => {
  const { sessions } = voiceRig();
  const started = await sessions.start(OVER_CAP);
  assert.equal(started.ok, true, started.detail);
  assert.equal(started.active, true, "the call itself still starts");
  assert.ok(started.detail.includes("over the 16 KB limit"), started.detail);
  assert.ok(started.detail.includes("runs without it"), started.detail);
  sessions.end(started.sessionId!);
});
