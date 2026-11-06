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
 *    verified by the service — not a throw). The adapter spawns
 *    /bin/zsh by default (the resident Mac); the tests pass the
 *    shell that exists on the host running them (/bin/zsh, else
 *    /bin/sh) so the same end-to-end exercise runs on Linux CI.
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
  LazyMacHostAdapter,
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

/**
 * Shell the adapter spawns for shellRun on THIS host: the production
 * /bin/zsh when it exists (the resident Mac, this VM), else /bin/sh.
 * The adapter defaults to /bin/zsh — right on macOS, wrong on a
 * Linux CI runner that has no zsh (spawn fails, so the adapter's
 * designed 127 comes back as data and the exit-code assertion
 * fails). The test passes the shell that exists here instead of
 * hard-coding either one. Production behavior is untouched;
 * GUS_TEST_SHELL forces a specific shell for the portability check.
 */
const testShell =
  process.env.GUS_TEST_SHELL ?? (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh");

function adapter(extra: { timeoutMs?: number; shellPath?: string } = {}): NativeMacHostAdapter {
  return new NativeMacHostAdapter({ socketPath, helperPath: noHelper, shellPath: testShell, ...extra });
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

test("native: shellRun honours the shellPath override (the /bin/sh path CI exercises)", async () => {
  assert.ok(existsSync("/bin/sh"), "/bin/sh must exist for this check");
  const a = new NativeMacHostAdapter({ socketPath, helperPath: noHelper, shellPath: "/bin/sh" });
  const ok = await a.shellRun("echo hello-sh", dir);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /hello-sh/);
  const bad = await a.shellRun("exit 3", dir);
  assert.equal(bad.exitCode, 3, "the override shell returns the exit code as data too");
});

// ---------------------------------------------------------------- wiring

class FakeNativeAdapter extends UnavailableMacHostAdapter {
  opened: string[] = [];
  override async openApp(app: string): Promise<string> {
    this.opened.push(app);
    return `opened "${app}"`;
  }
}

test("wiring: with no helper present, calls refuse plainly as not installed", async () => {
  const a = createMacHostAdapter({}, () => false);
  await assert.rejects(() => a.openApp("Calculator"), /not installed/);
});

test("wiring: a helper appearing after boot is picked up on the next call (boot-race fix)", async () => {
  let present = false;
  const fake = new FakeNativeAdapter();
  const a = createMacHostAdapter({}, () => present, () => fake);
  await assert.rejects(() => a.openApp("Calculator"), /not installed/);
  present = true;
  assert.equal(await a.openApp("Calculator"), 'opened "Calculator"');
  assert.deepEqual(fake.opened, ["Calculator"]);
});

test("wiring: GUS_MAC_HOST=1 forces the native path even with no socket file", async () => {
  const a = createMacHostAdapter(
    { GUS_MAC_HOST: "1", GUS_MAC_HOST_SOCKET: join(dir, "absent.sock") },
    () => false,
  );
  await assert.rejects(
    () => a.openApp("Calculator"),
    (e: unknown) => !/not installed/.test(e instanceof Error ? e.message : String(e)),
  );
});

test("wiring: the socket path comes from GUS_MAC_HOST_SOCKET", () => {
  const a = createMacHostAdapter({ GUS_MAC_HOST_SOCKET: "/tmp/custom.sock" }, () => true);
  assert.ok(a instanceof LazyMacHostAdapter);
  assert.equal((a as LazyMacHostAdapter).socketPath, "/tmp/custom.sock");
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
