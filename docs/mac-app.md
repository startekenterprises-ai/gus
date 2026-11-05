# GUS.app — the native Mac bridge and DMG (Phase 8)

Phase 7 built the Mac-control pack and left one seam open: the
native host bridge behind `MacHostAdapter`. Phase 8 fills it, with
three pieces and no governance changes:

| Piece | Where | What |
|---|---|---|
| `GusMacHost` (Swift) | `hosts/mac-app/Sources/GusMacHost/` | The helper that actually drives the desktop: Accessibility observe/click/focus, CGEvent input, ScreenCaptureKit screenshots |
| `GUS.app` (Swift) | `hosts/mac-app/Sources/GusApp/` | Menu-bar shell: status, Start/Stop, first-run permissions window; launches the helper from inside the bundle |
| `NativeMacHostAdapter` (Node) | `packages/control-plane/src/mac-native.ts` | The control plane's side of the seam: delegates desktop calls to the helper over a unix socket; files and shell execute locally in the control plane |

> Status: the Node adapter, the protocol, and the wiring are in the
> repo and unit-tested against a mock helper (129 → 139 tests). The
> Swift side is written carefully against the macOS 14 SDK surface
> but is **Mac-only and unverified until the install sitting** — it
> cannot be compiled on the Linux dev VM, and this doc does not
> pretend otherwise. The DMG is built and the drill is run in the
> sitting (checklist at the end).

## How it fits together

```
Telegram ──► control plane (launchd, Node) ──► MacService
                                                  │ desktop calls
                                                  ▼ NDJSON / unix socket
                                             GusMacHost (Swift, in GUS.app)
                                                  │
                                             Accessibility · CGEvent ·
                                             ScreenCaptureKit · NSWorkspace
```

The control plane wires the native adapter when the helper is
plausibly present — `GUS_MAC_HOST=1`, or the helper socket exists —
and the plainly-refusing `UnavailableMacHostAdapter` everywhere
else (`createMacHostAdapter` in `mac-native.ts`). A Linux dev box
and a pre-install Mac therefore keep failing `mac_*` calls loudly
and honestly, exactly as Phase 7 left them.

## The protocol

Newline-delimited JSON over `~/.gus/comm/mac-host.sock` (0600;
override with `GUS_MAC_HOST_SOCKET`), one request and one response
per line:

```
{"id": 1, "method": "click", "params": {"element": "Save"}}
{"id": 1, "ok": true, "result": "clicked element \"Save\""}
{"id": 2, "ok": false, "error": "no element labeled \"Save\" is visible in the front app (\"Finder\")"}
```

Methods: `observe`, `probe`, `click`, `type`, `key`, `scroll`,
`openApp`, `focusWindow`, `pickerSelect` — 1:1 with the adapter.
Files (`readFile`/`writeFile`) and shell (`shellRun`) never cross
the socket: the adapter runs them locally with `node:fs` and
`/bin/zsh -lc`, inside the jail MacService enforces before the call.

Result shapes:

- `observe` → `{app, windowTitle?, focusedElement?, text}` — the
  contract's text form (front app's accessibility tree, bounded:
  depth 8, 400 nodes, `role "label"` per line) — plus an optional
  `screenshotPngBase64` when Screen Recording is granted. The
  service contract is unchanged; the screenshot is additive.
- `probe` → `{frontApp, windowTitle?, focusedElement?, pickerSelection?}`.
- Mutating methods → the receipt string, **verbatim** in the
  canonical `macActionReceipt` form (mac.ts): `clicked element "X"`
  / `clicked point (x, y)`, `typed N chars` (N counts UTF-16 units,
  matching JS `.length`), `pressed COMBO`, `scrolled DIR by N`,
  `opened "APP"`, `focused window "T"` / `focused app "A"`,
  `selected "PATH"`. The Swift side hard-codes the same forms; the
  mock helper in `test/fixtures/mock-mac-host.mjs` pins them for
  both languages, and MacService fails any job whose receipt drifts.

Per-call timeout is 15s. If the socket is absent but the installed
helper binary exists (`~/.gus/app/GusMacHost`, or
`GUS_MAC_HOST_BIN`), the adapter spawns it once and retries the call
once; every other failure — dead helper, helper error, timeout —
throws, and MacService settles the job failed-loudly. Nothing
retries silently, nothing invents a result.

### What each helper method does

- **observe** — front app via NSWorkspace; AX tree walk; focused
  window/element; screenshot of the main display via
  `SCScreenshotManager` (macOS 14+) when permitted.
- **click** — by label: AX tree search by the same labels observe
  prints, then `AXPress`. By point: CGEvent mouse move/down/up.
- **type** — CGEvent unicode keyboard events, per character.
- **key** — combo parser (`cmd+shift+g`, `return`, arrows, f-keys…)
  to CGEvent key events with modifier flags.
- **scroll** — CGEvent line-unit scroll wheel (platform sign
  convention: down/right are negative wheel data).
- **openApp** — NSWorkspace open (found in /Applications,
  /System/Applications, ~/Applications, or by bundle id), then
  activate; MacService probe-verifies the front app afterwards.
- **focusWindow** — activate the app, then AX raise + main/focused
  on the window with the requested title.
- **pickerSelect** — requires a sheet/dialog in the front app
  (refuses plainly otherwise): Cmd+Shift+G, type the path, Return,
  then `AXPress` the dialog's Open button when present. The helper
  remembers the selection for `probe`.

## GUS.app

A menu-bar app (`LSUIElement`, bundle id
`com.startekenterprises.gus`, GUS branding only):

- **Menu**: live status line (running/stopped + front app),
  Start GUS / Stop GUS (launchctl bootstrap/bootout + kickstart on
  `com.startekenterprises.gus.control-plane` and `.runtime`),
  Setup & Permissions…, Open Setup Panel (http://127.0.0.1:8731),
  Quit. Quitting also stops the helper it launched.
- **First-run window** (opens itself when `~/.gus/state` doesn't
  exist): a live checklist — Accessibility (`AXIsProcessTrusted`,
  with the prompt + a System Settings deep link), Screen Recording
  (`CGPreflightScreenCaptureAccess`, marked optional: text
  observations work without it), Node ≥ 22 presence, and an
  **Install GUS services** button that does the bundled install in
  Swift: creates `~/.gus` layout (0700), seeds the Nova policy
  **only if none exists**, renders the two launchd plists from the
  bundle's templates, and loads them.

Because `GusMacHost` runs as the app's helper from
`Contents/Helpers`, the Accessibility and Screen Recording grants
the operator gives GUS.app are the grants the helper works under.

## Building the DMG

On the resident Mac (Xcode Command Line Tools installed):

```sh
sh hosts/mac-app/build-dmg.sh
```

The script checks its toolchain first and fails loudly by name when
something is missing (not on a Mac, no `swift`, no `codesign` /
`hdiutil`, no Node ≥ 22). It then builds the Node dist and the Swift
release binaries, assembles `GUS.app` — app + helper + a
`Contents/Resources/gus/` payload carrying every package's `dist/`,
`node_modules/@gus/*` as relative symlinks back into that payload
(all GUS dependencies are workspace-internal; there is nothing
third-party to bundle — the layout is verified to resolve), the
policy template, and the plist templates — ad-hoc codesigns it
(`codesign --sign -`, verified), and writes
`hosts/mac-app/dist/GUS-<version>.dmg` (version from the repo
`package.json`) with an /Applications symlink for drag-install.

**Gatekeeper, honestly:** ad-hoc signing is not notarization.
First launch is right-click → Open. Notarized distribution needs
an Apple Developer account and is a later, deliberate step.

## The install sitting (finish line)

1. `xcode-select --install` if needed; run `build-dmg.sh`; install
   `GUS.app` from the DMG.
2. First-run window: grant Accessibility (+ Screen Recording) to
   GUS.app; confirm Node ≥ 22; **Install GUS services**.
3. Edit `mac.workDirs` in `~/.gus/state/policy.json` to the real
   project dirs — until then the template approves no file or
   shell access at all.
4. Create the Telegram bot (BotFather); store the token in the
   vault via the Setup Panel. Secrets never transit Telegram.
5. Acceptance drill (docs/mac-resident.md), operator hands-off:
   picker select → open app → small edit in a work dir → run the
   project's tests; Once-class steps resolve from the phone; the
   kill switch stops GUS mid-job.
