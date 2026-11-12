# Publishing a GUS release (v0.9.5, Step 2)

GUS can publish its own app releases to GitHub — the last manual
step of the build pipeline (build the DMG, then hand it to a human
to drag into a draft release) becomes a job the agent runs under
the same rules as everything else: classified, approved, receipted,
verified.

## The tool

`github_publish_release` with exact arguments:

```json
{"tool": "github_publish_release",
 "args": {"tag": "v0.9.5",
          "dmgPath": "/Users/you/gus/hosts/mac-app/dist/GUS-0.9.5.dmg",
          "shaPath": "/Users/you/gus/hosts/mac-app/dist/GUS-0.9.5.dmg.sha256"}}
```

Prerequisites, all operator-side:

1. A **draft** release for the tag exists on
   `startekenterprises-ai/gus` (the pack publishes drafts; it never
   creates releases).
2. The DMG + `.sha256` pair exists locally — `hosts/mac-app/build-dmg.sh`
   produces exactly this pair in `hosts/mac-app/dist/`.
3. The publish credential is in the vault under the name `github`:
   a fine-grained GitHub personal access token, repository access
   limited to `startekenterprises-ai/gus`, **Contents: Read and
   write** (that permission covers release asset uploads and
   publishing). Store it in the panel (Setup → Vault) or with
   `vault-admin`. There is no read-back, by design.

## The rules it runs under

- **Every publish parks.** The classifier treats
  `github_publish_release` as an external-send and parks it for a
  one-time, hash-bound approval naming the exact tag and both file
  paths. No standing approval and no policy rule can pre-allow it —
  publishing is Once forever, like Gmail deletes. (Governor
  *permissive* mode proceeds past parks as recorded let-throughs,
  as it does for every class — that is the operator's standing
  instruction, with receipts.)
- **The pair is verified before any network call.** Both files
  must exist, be named exactly `GUS-<version>.dmg` /
  `GUS-<version>.dmg.sha256` for the tag, the checksum file must
  name that DMG, and the DMG's computed sha256 must equal it. Any
  mismatch refuses loudly with nothing uploaded.
- **Retries resume; they never duplicate or silently replace.**
  An asset already on the release at the expected name **and**
  size is skipped. A same-name asset at a different size refuses
  loudly — delete the stale asset on GitHub by hand and retry.
- **The outcome is verified against GitHub.** After uploading and
  un-drafting, the pack reads the release back: published, both
  assets present at exactly the local sizes. Anything less settles
  the job failed-loudly.

## Why it lives in the control plane

The token is used only inside Vault Broker `withSecret` callbacks
in the control-plane process (the Gmail/Mac pack pattern). There
is deliberately no script route: a script run as a shell job is a
child process, and a vault value never crosses a process boundary —
a script could only reach the token by decrypting the vault files
itself, which is the parallel secret path the vault exists to
forbid. The egress proxy cannot substitute either: its bodies are
strings the model supplies through the comm bridge, and a DMG is
binary the model never holds.

Revocation is two-sided, as with every pack: remove the vault
secret (`vault-admin remove github` / the panel), or revoke the
token on GitHub.
