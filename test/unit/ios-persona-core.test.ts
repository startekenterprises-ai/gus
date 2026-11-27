/**
 * v0.40.0: the persona-to-Core pins on the phone side.
 *
 * What is pinned here:
 *  - The transport: PersonaContextTransport is the one
 *    door — it reads the ONE composition
 *    (LocalBrain.activePrompt) and enforces the one cap
 *    (16,384 UTF-8 bytes, mirroring @gus/shared's
 *    MAX_PERSONA_CONTEXT_BYTES), refusing over-cap rather
 *    than truncating.
 *  - Chat: dispatchCore sends the composed context with
 *    every Core job, and an over-cap composition is
 *    refused in words with NOTHING sent (the core refuses
 *    in the same words at its own door).
 *  - Calls: connect() opens the session with the current
 *    composition and names the over-cap case on the
 *    call's notice; syncCorePersonaContext posts only a
 *    difference and only an accepted post moves the
 *    marker; it runs in the poll loop and ahead of every
 *    turn the phone dispatches itself (typed, spoken
 *    final, photo); endCall drops the marker with the
 *    session.
 *  - The client: chat carries the field only when a
 *    context is given; the voice start is body-less
 *    without one (older behavior byte-identical); the
 *    context update posts to its own route and decodes
 *    the 409 refusal's words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const localBrain = read("apps/ios/Shared/LocalBrain.swift");
const client = read("apps/ios/Shared/GUSClient.swift");
const chatView = read("apps/ios/App/ChatView.swift");
const callSession = read("apps/ios/Shared/CallSession.swift");

test("transport: one door, the one composition, the shared cap", () => {
  assert.ok(localBrain.includes("enum PersonaContextTransport"));
  assert.ok(localBrain.includes("static let maxBytes = 16_384"));
  assert.ok(
    localBrain.includes("let prompt = LocalBrain.activePrompt"),
    "the transport carries the one composition — persona, style, memories — never a second assembly",
  );
  assert.ok(localBrain.includes("prompt.utf8.count <= maxBytes"), "the cap is measured in UTF-8 bytes");
});

test("client: chat and voice start carry the field; the update has its own route", () => {
  assert.ok(client.includes('body["personaContext"] = personaContext'));
  assert.ok(client.includes("func voiceSessionStart(personaContext: String? = nil)"));
  assert.ok(client.includes("func voiceSessionContext(sessionId: String, personaContext: String?)"));
  assert.ok(client.includes('"/api/voice/session/context"'));
  assert.ok(
    client.includes("status == 200 || status == 409"),
    "the update's refusal (409) is decoded for its words, not thrown away",
  );
});

test("chat: every Core job carries the composition; over-cap sends nothing", () => {
  assert.ok(chatView.includes("let persona = PersonaContextTransport.current()"));
  assert.ok(chatView.includes("personaContext: persona.context"));
  assert.ok(chatView.includes("if persona.overCap"));
  assert.ok(
    chatView.includes("nothing was sent. Trim the persona's prompt or its remembered lines"),
    "the refusal is in words, on the exchange, before any dispatch",
  );
});

test("call: the start opens with the composition; the sync keeps it current", () => {
  assert.ok(callSession.includes("client.voiceSessionStart(personaContext: persona.context)"));
  assert.ok(callSession.includes("corePersonaContext = persona.context"));
  assert.ok(callSession.includes("private func syncCorePersonaContext() async"));
  assert.ok(
    callSession.includes("context != corePersonaContext"),
    "only a difference posts — the marker is the core's known state",
  );
  assert.ok(
    callSession.includes("await syncCorePersonaContext()"),
    "the poll loop syncs, so background changes and core-started turns are covered",
  );
  const dispatchSyncs = callSession.split("await self.syncCorePersonaContext()").length - 1;
  assert.ok(
    dispatchSyncs >= 3,
    `typed, spoken-final, and photo turns each sync before dispatching (found ${dispatchSyncs})`,
  );
  assert.ok(
    callSession.includes("corePersonaContext = nil"),
    "endCall drops the marker with the session",
  );
});
