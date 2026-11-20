# egress/ — Egress Proxy (Phase 1, built)

The sandbox's only path to the outside world — and it is not a network
path. The sandbox has no network at all; when the agent wants a URL,
the CONTROL PLANE performs the fetch here and relays the screened
result back over the comm socket (foundation spec §§1.3/1.7).

## Enforcement, in order, all outside the model

1. **Allowlist.** The destination (exact host + port) must appear in
   `egress-policy.json` in control-plane state. The policy is re-read
   on every call; a missing or malformed policy is deny-all. Only
   http/https schemes are permitted.
2. **Outbound screening.** URL, header values, and body are scanned
   with the secret-guard (S1 patterns) and checked against every value
   in the vault. A secret value may leave only inside the one header
   slot the proxy itself fills — anywhere else it is blocked and
   logged redacted.
3. **Injection at the edge.** A request may name a vault secret; a
   policy binding for (host, port, name) must exist, and the proxy then
   sets the bound header from the vault, overwriting any agent-supplied
   copy. The value exists only in this process's memory, per request.
4. **Redirects** are followed manually (max 3), each hop re-checked
   against the allowlist. An injected credential is never carried off
   its binding: a redirect that would move it blocks the request.
5. **Response screening.** Bodies are scrubbed of every vault value and
   S1-screened before returning toward the sandbox. An API that echoes
   the credential back gets its echo withheld — the agent never holds
   the value, so it can never relay it.
6. **Logging + receipts.** Every call, allowed or blocked, appends a
   line to `egress.jsonl` (destination, secret NAMES used, byte counts,
   verdict — never values) with a receipt from the gate package's
   issuer. Phase 1 uses the local stub issuer, stamped
   `gus-local-stub`; real Agent-Shield Protocol receipts integrate in
   Phase 4, and fetched content additionally passes the Shield gate
   there (choke point 1, §1.7).

## Known limit

Hostnames are matched as written; DNS resolution happens at fetch time
with no resolved-IP pinning yet. Exact on the drill's loopback surface;
IP pinning is a hardening item for hostile-network deployments, not a
Phase 1 claim.
