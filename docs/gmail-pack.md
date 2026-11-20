# The Gmail pack (Phase 6)

GUS's first capability pack: Gmail, executed entirely in the control
plane. Calendar is a separate later pack — nothing here touches it.

The agent can: search, read, and summarize mail; draft; send; reply;
label and archive; delete (trash or permanent); report spam; and
block senders. Every one of those runs through the same machinery as
the rest of GUS — the Shield gate, the classifier, the Approval
Engine, receipts — plus two pack-specific content rules:

- **Inbound mail is Agent-Shield-scanned before the model reads it.**
  A message the gate blocks is withheld: the model hears that it was
  withheld and why, never the content.
- **Outbound mail passes the secret-guard before anything leaves** —
  both the S1 pattern screen and a check against the actual values in
  the vault. A hit refuses the send/draft/reply outright, naming the
  pattern class or the vault secret's *name* — never a value.

Every action verifies its post-condition against the mailbox (the
sent message exists in the right thread, the labels actually moved,
the deleted message is actually gone) and ends verified-done or
failed-loudly.

## The permission model: Once / Always / Never

| Setting | Mechanism | Meaning |
|---|---|---|
| **Once** (default) | Approval Engine | One exact action, hash-bound to its arguments, single use. Change a recipient, a subject, one message ID — the approval no longer matches and the action parks again. |
| **Always** | Standing approvals in `policy.json` | A standing approval scoped to an action class (`gmail-send`, `gmail-reply`, `gmail-modify`) and, for sends, to a **person**, a **domain**, or an operator-named **group**. |
| **Never** | A `deny` rule in `policy.json` | Deny rules are matched before everything else. Never beats Always, always. |

### The hard lines (code, not policy — no file can soften them)

These are the Yue rules, named for the incident they answer:

- **Deletes are never always-eligible.** Every `gmail_delete` needs a
  one-time approval enumerating the exact message IDs.
- **Bulk actions are never always-eligible.** Any gmail action naming
  more than one message needs a one-time approval enumerating the
  exact message IDs. (Single-message label/archive/spam can be
  covered by a `gmail-modify` standing approval.)
- **First-time external recipients always prompt.** A send or reply
  to an address the mailbox has never corresponded with — the pack
  keeps the list in `<state>/gmail-directory.json`, learned from mail
  GUS has fetched and sends that have landed — needs a one-time
  approval, standing approvals notwithstanding. Once that first send
  is approved and lands, the correspondent is known.

The natural Always class is replies in an existing thread to known
recipients:

```json
{
  "standingApprovals": [
    { "actionClass": "gmail-reply", "reason": "thread replies to known correspondents" },
    { "actionClass": "gmail-send", "scopeType": "domain", "scopeValue": "corp.example", "reason": "the work domain" },
    { "actionClass": "gmail-send", "scopeType": "group", "scopeValue": "family", "reason": "family mail" },
    { "actionClass": "gmail-modify", "reason": "single-message filing" }
  ],
  "groups": {
    "family": ["sheryl@example.com", "@family-domain.example"]
  },
  "rules": [
    { "tool": "gmail_send", "action": "deny", "reason": "uncomment to switch sending off entirely" }
  ]
}
```

(Group members are addresses, or domains written as `@example.com`
or `example.com`. A scoped standing approval covers a send only when
**every** recipient is in scope. A reply that names no recipients —
they resolve from the thread at execution — can only be covered by an
*unscoped* `gmail-reply` approval, because a scoped one cannot be
checked against a recipient the call doesn't name.)

## Setup (operator, one time)

The OAuth credential lives in the vault under the name
**`gmail-oauth`**, as one JSON value:
`{"client_id": "...", "client_secret": "...", "refresh_token": "..."}`.
It never enters the agent's context. Getting those three values:

1. **Google Cloud project** (console.cloud.google.com): create or
   pick a project, then **Enable APIs → Gmail API**.
2. **OAuth consent screen**: user type *External*. Two gotchas:
   - In **Testing** status, Google expires refresh tokens after
     **7 days**. Set the publishing status to **In production** to
     keep the token alive; for a personal single-user app you will
     click through an "unverified app" warning during consent —
     expected, it's your own app.
   - Scopes: request `https://www.googleapis.com/auth/gmail.modify`
     (read, label, archive, send, trash, spam, filters). One
     exception: **permanent** delete needs
     `https://mail.google.com/` instead. Grant the wider scope only
     if you want permanent delete to work; with `gmail.modify` alone,
     trashing works and permanent deletes fail loudly with Google's
     refusal.
3. **Credentials → Create OAuth client ID → Desktop app.** Note the
   client ID and client secret.
4. **Get a refresh token**: the fastest no-code route is Google's
   OAuth 2.0 Playground (developers.google.com/oauthplayground):
   gear icon → *Use your own OAuth credentials* → paste the client
   ID/secret → authorize the Gmail scope above → *Exchange
   authorization code for tokens* → copy the **refresh token**.
5. **Store it in the vault** (from the control-plane directory, with
   `GUS_STATE_DIR` pointing at your state dir):

   ```sh
   node main.js vault-admin add gmail-oauth -
   # paste the JSON value, then Ctrl-D
   node main.js gmail-admin status
   ```

   `status` prints setup state, directory counts, and an OAuth
   health line (it performs a live token exchange, so a revoked
   or expired refresh token shows up here instead of failing
   silently later) — never a credential value.

## The cleanup layer (MVP chunks 1–5)

On top of the pack sits a deterministic cleanup engine
(`packages/control-plane/src/gmail-cleanup.ts`) for the overnight
inbox-cleanup MVP. It is **not a model tool** — the model has no
path to it. The operator decrees a rule file
(`<state>/gmail-cleanup-rules.json`: sender/domain/label/age rules
plus a never-archive list); the engine applies it to mailbox
metadata. This is how it coexists with the bulk hard line above:
the cleanup executes **only** against an exact-ID manifest a dry
run produced under that rule file — the enumeration the hard line
exists to force, produced before anything is touched. Ad-hoc agent
bulk actions still park exactly as before.

Guardrails, all in code: the engine's transport exposes only
search/get/modify (trash, delete, and send are unreachable from
it); the only archive mutation is `modify(id, [], ["INBOX"])`,
asserted before every call; the nightly cap is a code constant
(200 — the rule file may lower it, never raise it); exclusions
(starred, IMPORTANT, unread under 7 days, never-archive senders,
known correspondents unless a rule names the sender exactly) are
checked at selection **and again on fresh metadata immediately
before each modify**; the run manifest
(`<state>/gmail-cleanup/<batchId>.json`) is written before the
first modify and records each message's exact prior label set,
which is what undo restores. Settled runs and undos issue
receipts through the same local-stub issuer as job settlement,
appended to `<state>/receipts.jsonl` and hash-bound to the
manifest — tamper-evident local receipts, not Agent-Shield
Protocol receipts.

Operator surface:

```sh
node main.js gmail-admin status                     # pack state + OAuth health (live token exchange)
node main.js gmail-admin cleanup status             # the same health probe + rule-file/cap summary + scheduler armed state + pending proposal count
node main.js gmail-admin cleanup dry-run            # "would archive N, by rule" + manifest; changes nothing
node main.js gmail-admin cleanup archive --batch <batchId>   # execute exactly that dry run's manifest
node main.js gmail-admin cleanup undo --batch <batchId>      # restore the batch's exact prior label sets
node main.js gmail-admin cleanup show --batch <batchId>      # the batch's full record (tap-through; read-only)
node main.js gmail-admin cleanup verify --batch <batchId>    # re-check the batch's receipts against its manifest (read-only)
node main.js gmail-admin cleanup schedule enable --conversation <telegram chat id>   # arm the overnight run
node main.js gmail-admin cleanup schedule status    # armed state, run/report times, last run + report dates
node main.js gmail-admin cleanup schedule disable   # disarm (config kept)
node main.js gmail-admin cleanup proposals list     # pending rule proposals with their evidence
node main.js gmail-admin cleanup proposals generate # rescan unmatched senders for proposals (read-only)
node main.js gmail-admin cleanup proposals accept <id>   # append the proposed rule to the rule file (validated first)
node main.js gmail-admin cleanup proposals reject <id>   # resolve as no — final, never re-proposed
```

The overnight scheduler (chunk 3,
`packages/control-plane/src/gmail-cleanup-scheduler.ts`) ships
**disabled**: no config file means off, and a tick while disabled
makes no mailbox calls at all. Arming is the explicit `schedule
enable` above (a report conversation is required — an armed
scheduler with nowhere to send the morning report would fail
silently every night). The running control plane re-reads the
config (`<state>/gmail-cleanup-scheduler.json`) on every tick, so
arming lands without a restart. When armed, a timer checks every
15 minutes: at/after the run time (default 02:30 local) it runs
one cycle — a **fresh** dry-run selection, then the archive of
that run's own manifest, exactly the chunks 1–2 flow — and
at/after the report time (default 07:00) it sends the morning
report over Telegram (the channel host's send path) to the
configured chat. The report is built only from the batch's
manifests: archived counts by rule, left-alone counts, the batch
id, its receipt id, a trailing-7-days summary line ("This week:
…", chunk 5), and the undo command for the batch. A Mac
that slept through a window catches up at its first tick after
wake; a failed cycle (pack not set up, selection error) still
reports at report time — plainly, as a failure, with "nothing was
archived" — instead of staying silent. After a cycle settles it
also refreshes the rule proposals (chunk 4, below) from the
senders it left unmatched — a log line notes how many are
pending; the report text itself is unchanged.

### Tap-through (chunk 4)

Every line of the morning report resolves to its evidence. The
report's batch id + receipt id name a **batch record**: the run
manifest's entries verbatim (exact message IDs, the rule that
took each one, the prior label set its archive captured, the
per-entry outcome), the batch's job and receipt ids, and the
dry-run selection context when that manifest is still on disk.
Two read-only surfaces serve the same record, both built from
the manifest store and nothing else:

- `gmail-admin cleanup show --batch <batchId>` prints it.
- `GET /api/gmail-cleanup/batches/<batchId>` on the panel
  returns it as JSON for the panel/iPhone to render. GET only —
  any other method on that path is a 404 — and operator-token
  only: the record enumerates mail metadata, so it is *not* on
  the paired-device surface. An unwired backend answers 501; an
  unknown batch answers 404.

### Rule proposals (chunk 4)

After a cycle (or on `cleanup proposals generate`), a
deterministic, metadata-only scan tallies inbox senders that
**no rule matched**. A sender is proposed only on a strong bulk
signal: at least 3 unmatched messages, at least half carrying
one of Gmail's own bulk category labels (Promotions / Social /
Updates / Forums). The selection protections apply before
counting — starred, IMPORTANT, unread, never-archive senders,
and known correspondents are never proposed — and there are no
model calls: the heuristic is counts and labels, like the
selector. A proposal is a record in
`<state>/gmail-cleanup-proposals.json` holding the full proposed
rule (`proposed: <sender>` — archive from that sender) plus its
evidence (counts, date range, sample subjects).

A proposal **never takes effect on its own**: no cycle, dry
run, or archive consults the proposals file. `proposals accept
<id>` appends the rule to the rule file — but only after the
resulting file passes the same `loadCleanupRules` validation
the engine loads with, checked on a temp file, so a bad accept
leaves the real file byte-identical and the proposal pending.
Accepting changes the rule file's hash, so earlier dry-run
manifests stop matching it (chunk 2's rule) — dry-run again
before archiving. `proposals reject <id>` is final: the record
stays as the audit trail and the sender is never proposed
again.

### Hardening (chunk 5)

The final MVP pass hardens the edges the first four chunks left
to trust, without adding any mailbox surface — the transport
the engine can see is still search/get/modify, and nothing new
can archive, delete, or send:

- **Adversarial inputs fail closed, loudly.** The rule file is
  capped at 1 MiB, 256 rules, 1,000 entries per list, and 512
  characters per entry; ages must be finite (a JSON `1e999`
  parses to Infinity and is refused); duplicated list entries
  collapse to their canonical selves. A manifest that is
  unparseable, mislabelled, names a different batch than its
  file, holds more entries than the hard cap, names a message
  twice, or carries an unknown entry state is **corrupt**:
  every load throws a named error and leaves the file exactly
  as found. Absence is still absence (null) — the two are never
  confused.
- **Manifest writes are atomic** (tmp + rename, like the
  scheduler state): a crash mid-save leaves the previous
  complete manifest, so the write-ahead record is never torn.
  A leftover `.tmp` is never promoted — it may itself be the
  torn one. The scheduler's config save is atomic the same
  way, and its state load shape-checks every field (real
  `YYYY-MM-DD` dates; a pending report's fields are kept only
  when individually well-formed).
- **Transient failures retry; the mutations are idempotent.**
  Gmail 429/5xx responses and network errors are retried with
  backoff (4 attempts, 250 ms doubling) on search, reads, and
  modifies. The archive delta is remove-INBOX-only, so if a
  modify landed but its response was lost, the retry's fresh
  read sees INBOX already gone and stands down — a message is
  never archived twice, and the run manifest remains the
  single record. Undo recomputes its delta from a fresh read
  on every attempt, so a lost response there resolves to an
  empty delta and verification, never an overshoot.
  Non-transient failures (a 400, a refusal) are not retried —
  they fail exactly as before.
- **Receipt integrity is checkable.** `cleanup verify --batch
  <id>` re-verifies the receipts the batch's manifest names:
  each must be present in `<state>/receipts.jsonl`, carry a
  valid HMAC from the local issuer, and match the content hash
  recomputed from the settled manifest. A tampered manifest
  reads as `hash-mismatch`, a tampered log entry as
  `bad-signature`, a lost entry as `missing` — three different
  stories, three different verdicts. (The local-stub scheme
  has no cross-receipt chain to check; this is the integrity
  the pattern supports, and the seam the gate's real receipts
  will plug into.)
- **Catch-up is pinned.** A Mac off for days runs exactly one
  combined cycle on wake — still capped, never one run per
  missed day — and a stale undelivered report goes out before
  the fresh one.
- **Weekly summary.** The morning report's "This week:" line
  rolls the trailing 7 days of run manifests into batches /
  archived / undone / failed counts. Corrupt manifests are
  counted in the line, never silently skipped.

## Operator runbook (cleanup)

The short version of running this thing, in order:

1. **Setup status.** `node main.js gmail-admin cleanup
   status` — pack configured? OAuth healthy (it performs a
   live token exchange, so a revoked or 7-day-expired token
   shows here, not at 2 AM)? Rule file present, cap sane,
   scheduler armed or off, proposals pending?
2. **First dry run.** `cleanup dry-run` — read the "would
   archive N, by rule" counts and the sample IDs. Spot-check
   a few in Gmail. The dry run changes nothing; run it as
   often as you like. Any rule-file edit invalidates earlier
   manifests — dry-run again after edits.
3. **First batch by hand.** `cleanup archive --batch <id>`
   with the dry run's batch id, then `cleanup show --batch
   <id>` and eyeball the result in Gmail. Then the **undo
   drill**: `cleanup undo --batch <id>` and confirm every
   message is back with its prior labels. Do this once before
   arming anything.
4. **Arm the scheduler.** `cleanup schedule enable
   --conversation <telegram chat id>` (the chat the morning
   report should land in). Arming lands on the next tick — no
   restart. `schedule status` confirms; `schedule disable`
   turns it off and keeps the config.
5. **Read the morning report.** Archived counts by rule,
   left-alone counts, the batch + receipt line, the weekly
   line, and the undo command for the batch. `cleanup show
   --batch <id>` is the tap-through: every message the batch
   touched, under its receipt.
6. **What a failure report means.** "The overnight cleanup
   FAILED: … Nothing was archived" — the cycle died before a
   run manifest settled (pack not set up, selection error);
   the next night retries on its own once the cause is fixed.
   A report line "⚠️ N messages could not be archived" is
   different: the batch ran and settled failed-loudly; the
   manifest (`cleanup show`) names each failure, and `cleanup
   undo --batch <id>` still restores whatever did archive.
7. **When something looks wrong.** `cleanup verify --batch
   <id>` checks the batch's receipts against its manifest. A
   `corrupt manifest` error from any command means a file in
   `<state>/gmail-cleanup/` is damaged — it was left untouched
   and nothing ran against it; inspect it by hand rather than
   deleting it, since it may be a batch's only record.

## Revoking

One click, either side:

- `node main.js gmail-admin revoke` — removes the credential from
  the vault; the pack is dead from that moment.
- …or revoke GUS on the Google account's third-party access page,
  which kills the refresh token itself.

Deleting `<state>/gmail-directory.json` resets the learned directory
(every recipient becomes first-time again — the fail-safe direction).

## Known limitations

- **Cleanup tuning is data-pending.** Chunk 5's cap/exclusion
  tuning was scoped to "the first weeks' manifests" — no live
  runs exist yet, so there is nothing to tune from. The
  defaults (200/night cap, the chunk-1 exclusion set) stand
  until real manifests say otherwise; the weekly summary line
  is the surface that will show it.
- **Live-account test pending.** The pack is unit-proven against the
  mock transport and a fake HTTP layer (token exchange, message
  parsing, MIME send). The first run against a real mailbox happens
  in the OMEN session, alongside the container-drill re-runs this VM
  can't execute (its podman vehicle is broken).
- Summarize is the model's job on scanned content `gmail_read`
  returns; the pack adds no second model call of its own.
- Gmail actions ride each job's Governor caps like every other tool;
  the pack introduces no separate spend meter.
