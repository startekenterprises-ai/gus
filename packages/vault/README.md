# vault/ — Vault Broker (Phase 1)

Secrets live here, in the control plane: encrypted at rest (age), injected
at the egress proxy per-request, and never readable by the agent — there is
no API that returns a secret to the sandbox (foundation spec §1.3).

Phase 0 status: interface reserved; no code yet. The Phase 0 skeleton
proves the topology the vault will sit in.
