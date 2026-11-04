/**
 * Phase 7 unit tests: the Mac-control pack.
 *
 * What is pinned here:
 *  - The permission model in PolicyStore.classifyMac: the shipped
 *    Nova template's Always set (observe, open/focus, fs inside the
 *    approved work dirs, allowlisted shell in those dirs) proceeds;
 *    everything else is a Once — input injection, fs outside the
 *    jail, non-allowlisted / destructive / deleting / installing /
 *    publishing / credential-adjacent shell. Never (deny rules)
 *    beats Always; the declared class is a floor, never a downgrade;
 *    deletes park under the Yue rule and the allowlist can never
 *    cover them.
 *  - The shipped template object and docs/mac-policy-template.json
 *    are the same policy.
 *  - The execution rules in MacService against the fake host
 *    adapter: the jail holds at execution even for (hypothetically)
 *    approved actions; every action verifies its post-condition
 *    (read-back digest, probe state, canonical adapter receipt, exit
 *    code) and ends verified-done or failed-loudly; content crossing
 *    toward the model is Shield-scanned (blocked = withheld); text
 *    typed into the host passes the outbound secret-guard.
 *  - The unavailable adapter (what main.ts wires until the native
 *    bridge lands) refuses plainly.
 *
 * Everything runs against the fake adapter — no desktop, no network.
 * The real-Mac proof is the residency acceptance drill's job
 * (docs/mac-resident.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PolicyStore,
  DEFAULT_POLICY,
  type PolicyData,
} from "../../packages/control-plane/src/policy.js";
import {
  ApprovalEngine,
  describeAction,
} from "../../packages/control-plane/src/approvals.js";
import {
  FakeMacHostAdapter,
  MacService,
  NOVA_MAC_POLICY_TEMPLATE,
  UnavailableMacHostAdapter,
  classifyShellCommand,
  isMacTool,
  macResolveJailed,
  type MacProbe,
} from "../../packages/control-plane/src/mac.js";
import type { GmailShieldScanner } from "../../packages/control-plane/src/gmail.js";
import { VaultBroker } from "../../packages/vault/src/index.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gus-mac-"));
}

function storeWith(policy: unknown): PolicyStore {
  const dir = freshDir();
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify(policy));
  return new PolicyStore(path);
}

const TEMPLATE = NOVA_MAC_POLICY_TEMPLATE;
const PROJ = "/Users/you/Projects";
const call = (tool: string, args: Record<string, unknown>, declaredClass: "read" | "write" | "destructive" | "external-send" = "write") => ({
  tool,
  declaredClass: declaredClass as never,
  args,
});

// ------------------------------------------------------- Always (template)

test("always: the Nova template's always set proceeds", () => {
  const s = storeWith(TEMPLATE);
  assert.equal(s.classify(call("mac.observe", {}, "read")).action, "allow");
  assert.equal(s.classify(call("mac.open_app", { app: "Safari" })).action, "allow");
  assert.equal(s.classify(call("mac.focus_window", { app: "Safari" })).action, "allow");
  // fs inside the jail: absolute, and relative (against the first work dir)
  assert.equal(s.classify(call("mac.fs.read", { path: `${PROJ}/repo/README.md` }, "read")).action, "allow");
  assert.equal(s.classify(call("mac.fs.write", { path: "notes/today.md", content: "x" })).action, "allow");
  assert.equal(s.classify(call("mac.fs.write", { path: `${PROJ}/a/b.txt`, content: "x" })).action, "allow");
  // allowlisted shell in a work dir, including an all-allowlisted chain
  assert.equal(s.classify(call("mac.shell.run", { command: "npm test", cwd: PROJ })).action, "allow");
  assert.equal(s.classify(call("mac.shell.run", { command: "git status", cwd: `${PROJ}/repo` })).action, "allow");
  assert.equal(s.classify(call("mac.shell.run", { command: "npm run build && npm test", cwd: PROJ })).action, "allow");
  assert.equal(s.classify(call("mac.shell.run", { command: "ls -la", cwd: PROJ })).action, "allow");
});

test("always: strict defaults (no mac section) still let observe/open proceed but park fs and shell", () => {
  const bare: Record<string, unknown> = { ...(DEFAULT_POLICY as unknown as Record<string, unknown>) };
  delete bare.mac;
  const s = storeWith(bare);
  assert.equal(s.classify(call("mac.observe", {}, "read")).action, "allow");
  assert.equal(s.classify(call("mac.open_app", { app: "Safari" })).action, "allow");
  const fs = s.classify(call("mac.fs.read", { path: "/ anywhere.txt".trim() }, "read"));
  assert.equal(fs.action, "needs-approval");
  assert.match(fs.reason, /no approved Mac work directories/);
  assert.equal(s.classify(call("mac.shell.run", { command: "npm test", cwd: PROJ })).action, "needs-approval");
});

// ------------------------------------------------------------- Once (parks)

test("once: input injection always parks, bound to the exact action", () => {
  const s = storeWith(TEMPLATE);
  for (const [tool, args] of [
    ["mac.click", { element: "Save" }],
    ["mac.click", { x: 10, y: 20 }],
    ["mac.type", { text: "hello" }],
    ["mac.key", { combo: "cmd+enter" }],
    ["mac.scroll", { direction: "down", amount: 3 }],
    ["mac.picker.select", { path: "/Users/you/Downloads/avatar.png" }],
  ] as const) {
    const c = s.classify(call(tool, args as Record<string, unknown>, "read"));
    assert.equal(c.action, "needs-approval", `${tool} parks even when misdeclared read`);
    assert.match(c.reason, /one-time approval/);
  }
});

test("once: fs paths outside the jail park — dot-dot escapes and prefix tricks included", () => {
  const s = storeWith(TEMPLATE);
  for (const path of [
    "/Users/you/secret.txt",
    `${PROJ}/../secret.txt`,
    "/Users/you/ProjectsEvil/x.txt",
    "../outside.txt",
    "/etc/passwd",
  ]) {
    const c = s.classify(call("mac.fs.write", { path, content: "x" }));
    assert.equal(c.action, "needs-approval", path);
    assert.equal(c.effectiveClass, "destructive", path);
  }
  assert.equal(s.classify(call("mac.fs.read", { path: "" }, "read")).action, "needs-approval", "no path parks");
});

test("once: shell parks — deletes (Yue), destructive, installs, publishing, credential-adjacent, off-list, chained", () => {
  const s = storeWith(TEMPLATE);
  const shell = (command: string, cwd = PROJ) => s.classify(call("mac.shell.run", { command, cwd }));

  const del = shell("rm notes.txt");
  assert.equal(del.action, "needs-approval");
  assert.equal(del.effectiveClass, "destructive");
  assert.match(del.reason, /Yue rule/);

  // The allowlist can never launder a delete through a chain.
  const chained = shell("npm test && rm -rf build");
  assert.equal(chained.action, "needs-approval");
  assert.equal(chained.effectiveClass, "destructive");

  for (const [command, pattern] of [
    ["sudo ls", /sudo/],
    ["dd if=/dev/zero of=/dev/disk0", /destructive system operation/],
    ["kill 1234", /controls other processes/],
    ["mv a.txt b.txt", /moves/],
    ["brew install wget", /installs software/],
    ["npm install", /installs packages/],
    ["git push origin main", /git push/],
    ["ssh mac.example", /network shell/],
    ["curl https://example.test/x", /egress proxy/],
    ["security find-generic-password -s x", /credential-adjacent/],
    ["npm run deploy", /not on the operator's allowlist/],
    ["ls > out.txt", /redirection or substitution/],
    ["make release", /not on the operator's allowlist/],
  ] as const) {
    const c = shell(command);
    assert.equal(c.action, "needs-approval", command);
    assert.match(c.reason, pattern, command);
  }

  // Even an allowlisted command parks when its cwd leaves the jail.
  assert.equal(shell("npm test", "/tmp").action, "needs-approval");
  assert.equal(shell("npm test", `${PROJ}/../elsewhere`).action, "needs-approval");
  // And a missing command parks (an approval must name what runs).
  assert.equal(s.classify(call("mac.shell.run", { cwd: PROJ })).action, "needs-approval");
});

test("shell classifier: prefix matching, bare programs, and what stays off-list", () => {
  const list = TEMPLATE.mac.shellAllowlist;
  assert.equal(classifyShellCommand("npm run build -- --watch", list).action, "allow");
  assert.equal(classifyShellCommand("node --test test/unit", list).action, "allow");
  assert.equal(classifyShellCommand("pytest -q", list).action, "allow");
  assert.equal(classifyShellCommand("go vet ./...", list).action, "needs-approval");
  assert.equal(classifyShellCommand("echo hi", list).action, "needs-approval");
  assert.equal(classifyShellCommand("git commit -m x", list).action, "needs-approval");
  assert.equal(classifyShellCommand("$(rm -rf x)", list).action, "needs-approval");
  assert.equal(classifyShellCommand("", list).action, "needs-approval");
});

// ------------------------------------------------------- floor + Never wins

test("floor: the declared class is a floor for mac tools, never a downgrade", () => {
  const s = storeWith(TEMPLATE);
  // A read tool the runtime declares destructive parks anyway.
  const c = s.classify(call("mac.observe", {}, "destructive"));
  assert.equal(c.action, "needs-approval");
  assert.equal(c.effectiveClass, "destructive");
  assert.equal(s.classify(call("mac.open_app", { app: "Safari" }, "external-send")).action, "needs-approval");
  // And an unknown mac.* tool parks instead of slipping through defaults.
  assert.equal(isMacTool("mac.teleport"), true);
  assert.equal(s.classify(call("mac.teleport", {}, "read")).action, "needs-approval");
});

test("never: a policy deny rule beats the mac always set", () => {
  const s = storeWith({
    ...TEMPLATE,
    rules: [
      { tool: "mac.shell.run", action: "deny", reason: "no shell on this host" },
      { tool: "mac.open_app", action: "deny" },
    ],
  });
  assert.equal(s.classify(call("mac.shell.run", { command: "npm test", cwd: PROJ })).action, "deny");
  assert.equal(s.classify(call("mac.open_app", { app: "Safari" })).action, "deny");
  // Untouched tools keep their always behavior.
  assert.equal(s.classify(call("mac.observe", {}, "read")).action, "allow");
  // And vault_read is still hard-denied in code under the mac template.
  assert.equal(s.classify(call("vault_read", { name: "x" }, "read")).action, "deny");
});

// ------------------------------------------------------------- the template

test("template: the shipped const and docs/mac-policy-template.json are the same policy", () => {
  const fromDocs = JSON.parse(
    readFileSync(join(process.cwd(), "docs/mac-policy-template.json"), "utf8"),
  ) as PolicyData;
  assert.deepEqual(fromDocs, TEMPLATE);
  // The template's jail placeholder approves nothing real: paths under
  // it jail only against itself, and no operator path leaks in.
  assert.deepEqual(TEMPLATE.mac.workDirs, ["/Users/you/Projects"]);
  assert.ok(TEMPLATE.mac.shellAllowlist.includes("npm test"));
  assert.ok(!TEMPLATE.mac.shellAllowlist.some((e) => /(^|\s)(rm|sudo|curl|ssh)(\s|$)/.test(e)));
});

test("approvals: mac summaries name the exact action; mac approvals are hash-bound", () => {
  const shellSummary = describeAction("mac.shell.run", { command: "rm -rf build", cwd: PROJ });
  assert.ok(shellSummary.includes("rm -rf build") && shellSummary.includes(PROJ), shellSummary);
  assert.ok(describeAction("mac.picker.select", { path: "/x/y.png" }).includes("/x/y.png"));
  assert.ok(describeAction("mac.type", { text: "hello world" }).includes("hello world"));

  const engine = new ApprovalEngine(freshDir(), () => 60_000);
  const args = { element: "Save" };
  const req = engine.create({ jobId: "job1", conversationId: "c1", tool: "mac.click", args, reason: "test" });
  engine.resolve(req.id, "approved", "channel-button");
  assert.ok(engine.findExecutable("job1", "mac.click", { ...args }), "exact args match");
  assert.equal(engine.findExecutable("job1", "mac.click", { element: "Delete" }), undefined, "a different target is a different action");
  engine.stop();
});

// ------------------------------------------------------- service (fake host)

const WORK = "/work/proj";
function makeService(extra: { shield?: GmailShieldScanner; vault?: VaultBroker } = {}) {
  const adapter = new FakeMacHostAdapter();
  const service = new MacService(adapter, { workDirs: () => [WORK], ...extra });
  return { adapter, service };
}

test("service: fs.write verifies by read-back digest; fs.read returns the verified content", async () => {
  const { adapter, service } = makeService();
  const w = await service.execute("j1", "mac.fs.write", { path: `${WORK}/a.txt`, content: "hello mac" });
  assert.equal(w.ok, true, w.summary);
  assert.equal(adapter.files.get(`${WORK}/a.txt`), "hello mac");
  const r = await service.execute("j1", "mac.fs.read", { path: "a.txt" });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /hello mac/);
  assert.match(r.summary, /sha256/);
});

test("service: the jail holds at execution — escapes refuse before the adapter is touched", async () => {
  const { adapter, service } = makeService();
  const w = await service.execute("j1", "mac.fs.write", { path: "/etc/passwd", content: "x" });
  assert.equal(w.ok, false);
  assert.equal(w.refused, true);
  assert.match(w.summary, /outside the approved work directories/);
  assert.ok(!adapter.calls.includes("fs.write"), "the adapter never saw the write");
  const sh = await service.execute("j1", "mac.shell.run", { command: "npm test", cwd: "/tmp" });
  assert.equal(sh.refused, true);
  assert.ok(!adapter.calls.includes("shell"), "the adapter never ran the shell");
});

test("service: observe reports host state; a Shield block withholds it from the model", async () => {
  const { service } = makeService();
  const o = await service.execute("j1", "mac.observe", {});
  assert.equal(o.ok, true, o.summary);
  assert.match(o.summary, /front app=Finder/);

  const blocking: GmailShieldScanner = {
    scanSurface: async () => ({ action: "block", scanned: true, detail: "test block" }),
  };
  const { service: gated } = makeService({ shield: blocking });
  const b = await gated.execute("j1", "mac.observe", {});
  assert.equal(b.ok, false);
  assert.equal(b.refused, undefined, "withholding is not a refusal — the job continues");
  assert.match(b.summary, /withheld by the Agent-Shield gate/);
});

test("service: shell outcomes are verified by exit code, and output crosses scanned", async () => {
  const { adapter, service } = makeService();
  adapter.shellResults.set("npm test", { exitCode: 0, stdout: "109 passing\n", stderr: "" });
  const ok = await service.execute("j1", "mac.shell.run", { command: "npm test", cwd: WORK });
  assert.equal(ok.ok, true, ok.summary);
  assert.match(ok.summary, /109 passing/);
  const bad = await service.execute("j1", "mac.shell.run", { command: "false", cwd: WORK });
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, true);
  assert.match(bad.summary, /exit 1/);
  const echo = await service.execute("j1", "mac.shell.run", { command: "echo hello", cwd: WORK });
  assert.equal(echo.ok, true, echo.summary);
  assert.match(echo.summary, /hello/);
});

test("service: open/focus verify against the probe; a lying host fails loudly", async () => {
  const { service } = makeService();
  const open = await service.execute("j1", "mac.open_app", { app: "Safari" });
  assert.equal(open.ok, true, open.summary);
  const focus = await service.execute("j1", "mac.focus_window", { title: "Safari" });
  assert.equal(focus.ok, true, focus.summary);

  class LyingAdapter extends FakeMacHostAdapter {
    override async probe(): Promise<MacProbe> {
      return { frontApp: "Something Else", windowTitle: "Nope" };
    }
  }
  const lying = new MacService(new LyingAdapter(), { workDirs: () => [WORK] });
  const bad = await lying.execute("j1", "mac.open_app", { app: "Safari" });
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, true);
  assert.match(bad.summary, /front app is "Something Else"/);
});

test("service: input actions verify by canonical receipt; adapter failures fail loudly", async () => {
  const { adapter, service } = makeService();
  assert.equal((await service.execute("j1", "mac.click", { element: "Save" })).ok, true);
  assert.equal((await service.execute("j1", "mac.key", { combo: "cmd+enter" })).ok, true);
  assert.equal((await service.execute("j1", "mac.scroll", { direction: "down", amount: 3 })).ok, true);

  class MisreportingAdapter extends FakeMacHostAdapter {
    override async click(): Promise<string> {
      return "clicked something else entirely";
    }
  }
  const mis = new MacService(new MisreportingAdapter(), { workDirs: () => [WORK] });
  const bad = await mis.execute("j1", "mac.click", { element: "Save" });
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, true);
  assert.match(bad.summary, /post-condition does not hold/);

  adapter.failActions.add("key");
  const failed = await service.execute("j1", "mac.key", { combo: "cmd+q" });
  assert.equal(failed.ok, false);
  assert.equal(failed.refused, true);
  assert.match(failed.summary, /failed loudly/);
});

test("service: typing passes the outbound secret-guard — patterns and vault values refuse, nothing typed", async () => {
  const dir = freshDir();
  const vault = new VaultBroker(join(dir, "vault.json"), join(dir, "vault.key"));
  vault.add("api-key", "hunter2-super-secret-value");
  const { adapter, service } = makeService({ vault });

  // Built in pieces, like the gmail suite's: the canonical AWS
  // documentation example key is on the S1 allowlist by design (a
  // published placeholder), so the guard test uses a non-example key.
  const awsKey = "AKIA" + "GUSTEST123456789";
  const byPattern = await service.execute("j1", "mac.type", { text: `key is ${awsKey} ok` });
  assert.equal(byPattern.ok, false);
  assert.equal(byPattern.refused, true);
  assert.match(byPattern.summary, /secret-guard/);

  const byValue = await service.execute("j1", "mac.type", { text: "the password is hunter2-super-secret-value" });
  assert.equal(byValue.ok, false);
  assert.equal(byValue.refused, true);
  assert.match(byValue.summary, /api-key/, "the refusal names the secret, never its value");
  assert.ok(!byValue.summary.includes("hunter2"), "the value never appears in the refusal");

  assert.ok(!adapter.calls.includes("type"), "nothing was typed for either refusal");
  const clean = await service.execute("j1", "mac.type", { text: "ordinary words" });
  assert.equal(clean.ok, true, clean.summary);
});

test("service: the picker selects an exact path outside the fs jail (its approval is the control)", async () => {
  const { adapter, service } = makeService();
  const p = "/Users/you/Downloads/avatar.png";
  const r = await service.execute("j1", "mac.picker.select", { path: p });
  assert.equal(r.ok, true, r.summary);
  assert.equal(adapter.state.pickerSelection, p);
});

test("service: missing files and the unavailable adapter refuse plainly", async () => {
  const { service } = makeService();
  const missing = await service.execute("j1", "mac.fs.read", { path: `${WORK}/nope.txt` });
  assert.equal(missing.ok, false);
  assert.equal(missing.refused, true);
  assert.match(missing.summary, /failed loudly/);

  const un = new MacService(new UnavailableMacHostAdapter(), { workDirs: () => [WORK] });
  const r = await un.execute("j1", "mac.observe", {});
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.summary, /not installed on this host/);
  assert.match(r.summary, /mac-resident\.md/);
});

test("jail helper: resolution honors relative paths, roots, and escapes", () => {
  const dirs = [WORK];
  assert.equal(macResolveJailed("a/b.txt", dirs), `${WORK}/a/b.txt`);
  assert.equal(macResolveJailed(WORK, dirs), WORK);
  assert.equal(macResolveJailed(`${WORK}/../etc`, dirs), null);
  assert.equal(macResolveJailed("/work/project/x", dirs), null, "a prefix lookalike is not inside");
  assert.equal(macResolveJailed("a.txt", []), null, "no work dirs = nothing is jailed-in");
});
