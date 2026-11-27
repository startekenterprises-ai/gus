/**
 * v0.35.0: the navigation + Shield hub pins.
 *
 * What is pinned here:
 *  - The DEFCON level table (numbers, labels, glosses,
 *    colors) is the Agent-Shield posture page's own
 *    (agent-shield-connector POSTURE_LEVELS/POSTURE_COLORS),
 *    and BOTH apps carry it character-for-character — the
 *    iPhone's in ShieldKit, the Mac's mirrored in its own
 *    ProtectionStatus.swift, because the two apps share no
 *    code. A drifted label or color on either side fails
 *    here, not on a lock screen.
 *  - Each platform's mapping from its OWN local settings:
 *    iPhone — off → DARK, Permissive → DEGRADED, Standard →
 *    WATCH, Strict → STEADY (STRAIN unreachable: the
 *    on-device scanner is in-process); Mac — killed or
 *    unprovisioned → DARK, Governor permissive → DEGRADED,
 *    gate not required → STRAIN, fail-open → WATCH,
 *    enforcing + required + fail-closed → STEADY.
 *  - The hub's toggles write the SAME persisted keys
 *    ShieldSettings reads (gus.shield.enabled /
 *    gus.shield.posture) — a parallel state would let the
 *    hub and the scanner disagree about protection.
 *  - The tab bar has four roots; Settings is gone from it
 *    and lives behind Chat's hamburger, which also carries
 *    New Chat and About; the Shield tab hosts the hub, and
 *    the hub hosts the same ShieldLogView (embedded).
 *  - New Chat's honesty: the model drops the cached brain
 *    (the on-device context reset) and resets the session
 *    style, and its notices never claim a new thread or a
 *    deletion — deleting is Settings → Privacy's job, and
 *    both notices say so.
 *  - The Mac's main screen carries the badge and the
 *    Protection shortcut (settingsSection = .protection).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const iosStatus = read(
  "apps/ios/Packages/ShieldKit/Sources/ShieldKit/ProtectionStatus.swift",
);
const macStatus = read("hosts/mac-app/Sources/GusApp/ProtectionStatus.swift");
const shieldKit = read(
  "apps/ios/Packages/ShieldKit/Sources/ShieldKit/ShieldKit.swift",
);
const hub = read("apps/ios/App/ShieldHubView.swift");
const rootView = read("apps/ios/App/RootView.swift");
const chatView = read("apps/ios/App/ChatView.swift");
const settingsView = read("apps/ios/App/SettingsView.swift");
const shieldLog = read("apps/ios/App/ShieldLogView.swift");
const macRoot = read("hosts/mac-app/Sources/GusApp/RootView.swift");

/** The page's level table, verbatim — every literal must
 *  appear in BOTH platform definitions. */
const LEVEL_TABLE: Array<[string, string, string]> = [
  // label, gloss, color hex
  ["STEADY", "Calm", "#137333"],
  ["WATCH", "Watchful", "#6a9a00"],
  ["STRAIN", "Strained", "#b06000"],
  ["DEGRADED", "Impaired", "#c2410c"],
  ["DARK", "Down", "#d93025"],
];

test("defcon: the page's level table, identical on both platforms", () => {
  for (const [label, gloss, hex] of LEVEL_TABLE) {
    for (const [name, src] of [
      ["iOS ShieldKit", iosStatus],
      ["Mac ProtectionStatus", macStatus],
    ] as const) {
      assert.ok(src.includes(`"${label}"`), `${name} is missing label ${label}`);
      assert.ok(src.includes(`"${gloss}"`), `${name} is missing gloss ${gloss}`);
      assert.ok(src.includes(`"${hex}"`), `${name} is missing color ${hex}`);
    }
  }
  // The level numbers themselves: dark is 1, steady is 5.
  for (const src of [iosStatus, macStatus]) {
    assert.ok(src.includes("case dark = 1"));
    assert.ok(src.includes("case steady = 5"));
  }
});

test("defcon: the iPhone mapping from its own Shield settings", () => {
  assert.ok(iosStatus.includes("guard enabled else { return .dark }"));
  assert.ok(iosStatus.includes("case .permissive: return .degraded"));
  assert.ok(iosStatus.includes("case .standard: return .watch"));
  assert.ok(iosStatus.includes("case .strict: return .steady"));
});

test("defcon: the Mac mapping from its own panel status", () => {
  assert.ok(macStatus.includes("if s.killed || !s.shield.provisioned { return .dark }"));
  assert.ok(macStatus.includes('if s.governorMode == "permissive" { return .degraded }'));
  assert.ok(macStatus.includes("if !s.shield.required { return .strain }"));
  assert.ok(macStatus.includes('if s.shield.onUnavailable != "closed" { return .watch }'));
  assert.ok(macStatus.includes("return .steady"));
});

test("hub: toggles write ShieldSettings' own keys — no parallel state", () => {
  for (const key of ["gus.shield.enabled", "gus.shield.posture"]) {
    assert.ok(shieldKit.includes(`"${key}"`), `ShieldKit must persist ${key}`);
    assert.ok(hub.includes(`@AppStorage("${key}")`), `the hub must bind ${key}`);
  }
  // The hub hosts the log, embedded, as its lower half.
  assert.ok(hub.includes("ShieldLogView(embedded: true)"));
  assert.ok(shieldLog.includes("var embedded = false"));
  // The compact pill derives from the same keys.
  assert.ok(hub.includes("struct ProtectionStatusPill"));
  assert.ok(hub.includes("ShieldProtectionStatus.current("));
});

test("tabs: four roots, Settings gone, Shield tab is the hub", () => {
  const assertions = rootView.match(/\.toolbar\(\.visible, for: \.tabBar\)/g) ?? [];
  assert.equal(assertions.length, 4, "one visibility assertion per tab root");
  assert.ok(!rootView.includes('Label("Settings", systemImage: "gearshape")'),
    "the Settings tab item must be gone");
  assert.ok(rootView.includes("ShieldHubView()"), "the Shield tab hosts the hub");
  assert.ok(rootView.includes("ChatView(session: session)"),
    "Chat receives RootView's session for its Settings door");
});

test("hamburger: New chat, Settings, About — and New Chat's honest reset", () => {
  assert.ok(chatView.includes("line.3.horizontal"), "the hamburger glyph");
  assert.ok(chatView.includes('Label("New chat", systemImage: "square.and.pencil")'));
  assert.ok(chatView.includes('Label("Settings", systemImage: "gearshape")'));
  assert.ok(chatView.includes('Label("About", systemImage: "info.circle")'));
  assert.ok(chatView.includes("SettingsSheet(session: session)"));
  // The reset itself: drop the cached brain (its LLM
  // history is the on-device context) + reset session style.
  assert.ok(chatView.includes("func startNewChat()"));
  assert.ok(chatView.includes("PersonaSessionStyle.reset()"));
  assert.ok(chatView.includes("brain = nil"));
  // The notices tell the truth in both modes: history is
  // NOT deleted, and Core has no running context to clear.
  assert.ok(chatView.includes("Your history above is still saved; deleting it lives in Settings → Privacy."));
  assert.ok(chatView.includes("every message is already its own job, so there is no running conversation context there to clear"));
  // About is ONE view behind both doors.
  assert.ok(settingsView.includes("struct AboutSection: View"));
  assert.ok(settingsView.includes("AboutSection()"));
  assert.ok(chatView.includes("AboutSection()"));
  // The pill sits in Chat, under the mode line.
  assert.ok(chatView.includes("ProtectionStatusPill()"));
});

test("mac: badge + protection shortcut on the main screen", () => {
  assert.ok(macRoot.includes("ProtectionStatusBadge(status: status)"));
  assert.ok(macRoot.includes("model.settingsSection = .protection"));
  assert.ok(macRoot.includes("model.section = .settings"));
  assert.ok(macStatus.includes("struct ProtectionStatusBadge: View"));
});
