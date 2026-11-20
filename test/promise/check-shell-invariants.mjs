// Shell invariants (v0.14.0 — the R2 redo's chat/settings
// promises, kept as a grep-level check like check-budget.mjs):
//
//   (a) Chat's log presence is the one-line strip plus —
//       v0.14.5, the operator's bounded return — the in-place
//       panel: ChatView may reference SecureLogView ONLY in
//       its bounded form (expands: false + boundedHeight).
//       An expanding/full-size log in Chat is still forbidden
//       (its home is Jobs).
//   (b) The separate Settings window is gone — the string
//       "SettingsWindowController" appears nowhere in GusApp.
//   (c) Settings is a section of the main window — RootView
//       handles a .settings section.
//   (d) The pairing-grant flow is deleted — no GusApp source
//       references "/api/pairing" or "mintPairingGrant".
//   (e) Chat's one-line live status strip exists — ChatView
//       carries "liveStatusStrip".
//
// Run: npm run check:shell (deliberately NOT wired into
// `npm test` — it reads Swift sources, not the TS build).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appDir = join(root, "hosts", "mac-app", "Sources", "GusApp");
const sources = new Map(
  readdirSync(appDir)
    .filter((f) => f.endsWith(".swift"))
    .map((f) => [f, readFileSync(join(appDir, f), "utf8")]),
);

const failures = [];
const check = (ok, label) => {
  if (!ok) failures.push(label);
};

// (a)
const chatSource = sources.get("ChatView.swift") ?? "";
check(
  !chatSource.includes("SecureLogView")
    || (chatSource.includes("expands: false") && chatSource.includes("boundedHeight:")),
  "ChatView.swift embeds SecureLogView without the bound — the in-chat log must stay the bounded panel (expands: false + boundedHeight)",
);
check(
  !chatSource.includes("expands: true"),
  "ChatView.swift references an expanding SecureLogView — the full-size log belongs in Jobs, not Chat",
);

// (b)
for (const [file, text] of sources) {
  check(
    !text.includes("SettingsWindowController"),
    `${file} references SettingsWindowController — the separate Settings window was deleted in v0.14.0`,
  );
}

// (c)
check(
  (sources.get("RootView.swift") ?? "").includes(".settings"),
  "RootView.swift does not handle a .settings section",
);

// (d)
for (const [file, text] of sources) {
  check(
    !text.includes("/api/pairing"),
    `${file} references /api/pairing — the pairing-grant endpoints were deleted in R1`,
  );
  check(
    !text.includes("mintPairingGrant"),
    `${file} references mintPairingGrant — the pairing-grant flow was deleted in v0.14.0`,
  );
}

// (e)
check(
  (sources.get("ChatView.swift") ?? "").includes("liveStatusStrip"),
  "ChatView.swift has no liveStatusStrip — Chat keeps exactly one live-status line",
);

if (failures.length > 0) {
  console.error("Shell invariants violated:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Shell invariants hold (chat declutter, in-window Settings, no pairing flow).");
