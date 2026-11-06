# Governor modes — enforcing & permissive (v0.4)

SELinux had the right idea thirty years ago: an enforcement system
people can relax while they learn it gets adopted; one they can
only suffer gets uninstalled. GUS has two modes.

## Enforcing (default)

Shield verdicts bind. Classifier parks and denies bind. This is
the posture every install ships in and the one the marketing
claims describe.

## Permissive

Everything is still scanned by Agent-Shield and classified by the
policy layer — but a would-be **block** (Shield), **park**
(approval), or **deny** (classifier) proceeds instead. Each
let-through is recorded with what enforcing mode would have done:

- Shield side: the gate log entry carries `mode: "permissive"` and
  `wouldBe: "block"`, with the real verdict and its receipt.
- Classifier side: an entry in `permissive.jsonl` (and an
  `permissive_action` event) naming the tool and the reason it
  would have parked or been denied.

The panel shows today's count and the recent list; `/mode` in chat
reports the same. It is the firewall-disable troubleshooting loop
— except the thing you turned off keeps the receipts, so hardening
again is an informed decision, not a guess.

## The floors permissive can never cross

- **vault_read stays denied.** A secret entering model context is
  an irreversible disclosure, not a reversible action. The
  comm-server floors it before the mode is consulted.
- **The spend caps still stop at the ceiling**, and the **kill
  switch still halts everything.** Those are Governor mechanics —
  runaway insurance — not content policy. The mode never reaches
  them.
- **Scanning and receipting never turn off.** A mode with no
  receipts is just an unaccountable agent, and that product is not
  GUS.

## Flipping the mode

One state file — `~/.gus/state/governor-mode.json` — read at every
decision point, so a flip is live on the next action with no
restart. Absent or malformed = enforcing.

- **Panel**: Status → Governor mode → Enforcing / Permissive.
- **GUS.app menu**: Governor Mode → Enforcing / Permissive.
- **Chat**: `/mode`, `/mode permissive`, `/mode enforcing`
  (operator-only; delegates are refused, like /stop and /update).
