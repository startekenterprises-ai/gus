# vault/ — Vault Broker (Phase 1, built)

Secrets live here, in the control plane: encrypted at rest, injected at
the egress proxy per-request, and never readable by the agent — there
is no API that returns a secret to the sandbox (foundation spec §1.3).
The Phase 1 credential red-team drill
(`test/promise/phase1-drill.sh`) is the test case for that sentence.

## How it works

- **Store:** `vault.json` in control-plane state, written 0600. Each
  entry is a ChaCha20-Poly1305 ciphertext (nonce + auth tag stored
  alongside) under a 32-byte host key in `vault.key` (also 0600, in
  control-plane state — a volume the sandbox cannot see at all).
  *Substitution note:* the spec names age/XChaCha; Node's built-in
  `chacha20-poly1305` (12-byte nonce form) is used so the broker needs
  no external tooling. The property the spec depends on — authenticated
  encryption under an operator-held key file, ciphertext-only at rest —
  is identical.
- **Names are handles, not secrets.** Secrets are referenced by name
  (`test-api`, `cred:gmail-main`) everywhere outside this package. The
  name list is safe to show; values are not.
- **The use surface is a callback.** `withSecret(name, fn)` decrypts in
  control-plane memory and hands the value to a control-plane callback
  (the egress proxy's injection). Nothing returns a value across any
  boundary the sandbox can reach, and nothing on the comm bridge imports
  this package.
- **Detection without disclosure:** `findValuesIn(text)` and
  `redactValues(text)` let the egress proxy refuse outbound smuggling
  and scrub responses, working with names and markers only.

## Admin (operator side only)

```
node main.js vault-admin add <name> <value|->   # '-' reads value from stdin
node main.js vault-admin list                   # names only
node main.js vault-admin remove <name>
```

There is deliberately no `get`. The admin path runs as a separate
control-plane process invocation against the state dir and exits before
any server starts; it is never reachable from the sandbox.

Deferred: Google OAuth token acquisition into the vault (the digest
job's credential) lands with the digest job itself; hosted-tier KMS
wrapping of the host key is a hosted-ops concern (spec §3).
