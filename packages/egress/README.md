# egress/ — Egress Proxy (Phase 1)

The sandbox's only path to the outside world: allowlisted destinations,
auth injected by the Vault Broker at request time, fetched content passed
through the Agent-Shield gate before it can enter the agent's context
(foundation spec §§1.3/1.7).

Phase 0 status: the sandbox has no network at all; the proxy arrives with
the first job type that needs the outside (fetch & summarize).
