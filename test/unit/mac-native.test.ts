/**
 * Phase 8 unit tests: the native Mac host adapter.
 *
 * What is pinned here:
 *  - NativeMacHostAdapter speaks the GusMacHost wire protocol
 *    (newline-delimited JSON over a unix socket) against a mock
 *    helper that returns the exact canonical receipt strings — every
 *    delegated method passes the helper's receipt through verbatim.
 *  - Failure discipline: a helper error surfaces as a thrown error
 *    naming it; a missing socket throws a plain "not reachable"
 *    error; a slow helper hits the per-call timeout. Nothing is
 *    swallowed or invented (MacService turns throws into
 *    failed-loudly outcomes).
 *  - fs/shell stay local: readFile/writeFile round-trip on disk, and
 *    shellRun returns the exit code as a result (non-zero is data,
 *    verified by the service — not a throw).
 *  - The main.ts wiring rule (createMacHostAdapter): native only
 *    when GUS_MAC_HOST=1 or the helper socket exists; the plainly
 *    refusing unavailable adapter everywhere else.
 *  - Integration: MacService over the native adapter + mock helper —
 *    a verified click, and a receipt mismatch ending failed-loudly,
 *    mirroring the Fake-adapter tests in mac-pack.test.ts.
 *
 * Everything runs against the mock helper and the local filesystem —
 * no Mac, no desktop. The Swift helper's proof is the install
 * sitting (docs/mac-app.md).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeMacHostAdapter,
  createMacHostAdapter,
} from "../../packages/control-plane/src/mac-native.js";
import {
  MacService,
  UnavailableMacHostAdapter,
} from "../../packages/control-plane/src/mac.js";

const dir = mkdtempSync(join(tmpdir(), "gus-mac-native-"));
const socketPath = join(dir, "mac-host.sock");
const noHelper = join(dir, "no-such-helper");
let mock: ChildProcess;

before(async () => {
  mock = spawn(
    process.execPath,
    [join(process.cwd(), "test/fixtures/mock-mac-host.mjs"), socketPath],
    { stdio: "ignore" },
  );
  // Wait for the mock to bind its socket.
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(existsSync(socketPath), "the mock helper bound its socket");
});

after(() => {
  mock?.kill();
});

function adapter(extra: { timeoutMs?: number } = {}): NativeMacHostAdapter {
  return new NativeMacHostAdapter({ socketPath, helperPath: noHelper, ...extra });
}

// ------------------------------------------------------- delegated calls

test("native: observe and probe delegate to the helper and map its state", async () => {
  const a = adapter();
  const obs = await a.observe();
  assert.equal(obs.app, "Finder");
  assert.equal(obs.windowTitle, "Desktop");
  assert.match(obs.text, /front app: Finder/);
  const probe = await a.probe();
  assert.equal(probe.frontApp, "Finder");
  assert.equal(probe.pickerSelection, undefined);
});

test("native: mutating methods return the helper's canonical receipts verbatim", async () => {
  const a = adapter();
  assert.equal(await a.click({ element: "Save" }), 'clicked element "Save"');
  assert.equal(await a.click({ x: 10, y: 20 }), "clicked point (10, 20)");
  assert.equal(await a.typeText("hello mac"), "typed 9 chars");
  assert.equal(await a.key("cmd+enter"), "pressed cmd+enter");
  assert.equal(await a.scroll("down", 3), "scrolled down by 3");
  assert.equal(await a.openApp("Safari"), 'opened "Safari"');
  assert.equal(await a.focusWindow({ title: "Notes" }), 'focused window "Notes"');
  assert.equal(await a.focusWindow({ app: "Finder" }), 'focused app "Finder"');
  assert.equal(
    await a.pickerSelect("/Users/you/Downloads/avatar.png"),
    'selected "/Users/you/Downloads/avatar.png"',
  );
  // The helper's probe reflects what the actions actually did.
  const probe = await a.probe();
  assert.equal(probe.pickerSelection, "/Users/you/Downloads/avatar.png");
});

// ------------------------------------------------------------ failure modes

test("native: a helper error is thrown with its message, never swallowed", async () => {
  const a = adapter();
  await assert.rejects(a.click({ element: "__error__" }), /mock helper exploded/);
});

test("native: an absent socket fails plainly (and no helper binary means no spawn rescue)", async () => {
  const a = new NativeMacHostAdapter({
    socketPath: join(dir, "never-bound.sock"),
    helperPath: noHelper,
    timeoutMs: 2_000,
  });
  await assert.rejects(a.observe(), /not reachable/);
  await assert.rejects(a.click({ element: "Save" }), /not reachable/);
});

test("native: a helper that outlives the per-call timeout fails the call", async () => {
  const a = adapter({ timeoutMs: 150 });
  await assert.rejects(a.click({ element: "__slow__" }), /did not answer "click" within 150ms/);
});

// ------------------------------------------------------------- local calls

test("native: fs read/write are local and round-trip byte-for-byte", async () => {
  const a = adapter();
  const path = join(dir, "nested", "note.txt");
  await a.writeFile(path, "hello from the native adapter");
  assert.equal(await a.readFile(path), "hello from the native adapter");
  await assert.rejects(a.readFile(join(dir, "missing.txt")), /ENOENT/);
});

test("native: shellRun runs the exact command and returns the exit code as data", async () => {
  const a = adapter();
  const ok = await a.shellRun("echo hello-shell", dir);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /hello-shell/);
  const bad = await a.shellRun("exit 3", dir);
  assert.equal(bad.exitCode, 3, "a non-zero exit is a result the service verifies, not a throw");
});

// ---------------------------------------------------------------- wiring

test("wiring: createMacHostAdapter picks native only when the helper is plausibly present", () => {
  const no = () => false;
  const yes = () => true;
  assert.ok(createMacHostAdapter({}, no) instanceof UnavailableMacHostAdapter);
  assert.ok(createMacHostAdapter({ GUS_MAC_HOST: "1" }, no) instanceof NativeMacHostAdapter);
  assert.ok(createMacHostAdapter({}, yes) instanceof NativeMacHostAdapter);
  const custom = createMacHostAdapter({ GUS_MAC_HOST_SOCKET: "/tmp/custom.sock" }, yes);
  assert.ok(custom instanceof NativeMacHostAdapter);
  assert.equal((custom as NativeMacHostAdapter).socketPath, "/tmp/custom.sock");
});

// ------------------------------------------------------------- integration

test("integration: MacService over the native adapter verifies a click end-to-end", async () => {
  const service = new MacService(adapter(), { workDirs: () => [dir] });
  const click = await service.execute("j1", "mac.click", { element: "Save" });
  assert.equal(click.ok, true, click.summary);
  assert.match(click.summary, /mac\.click verified: clicked element "Save"/);
  const open = await service.execute("j1", "mac.open_app", { app: "Safari" });
  assert.equal(open.ok, true, open.summary);
});

test("integration: a mismatched receipt from the helper ends failed-loudly", async () => {
  const service = new MacService(adapter(), { workDirs: () => [dir] });
  const bad = await service.execute("j1", "mac.click", { element: "__mismatch__" });
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, true);
  assert.match(bad.summary, /post-condition does not hold/);
  assert.match(bad.summary, /clicked something else entirely/);
});
