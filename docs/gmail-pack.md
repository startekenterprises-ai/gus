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

   `status` prints setup state and directory counts — never a
   credential value.

## Revoking

One click, either side:

- `node main.js gmail-admin revoke` — removes the credential from
  the vault; the pack is dead from that moment.
- …or revoke GUS on the Google account's third-party access page,
  which kills the refresh token itself.

Deleting `<state>/gmail-directory.json` resets the learned directory
(every recipient becomes first-time again — the fail-safe direction).

## Known limitations

- **Live-account test pending.** The pack is unit-proven against the
  mock transport and a fake HTTP layer (token exchange, message
  parsing, MIME send). The first run against a real mailbox happens
  in the OMEN session, alongside the container-drill re-runs this VM
  can't execute (its podman vehicle is broken).
- Summarize is the model's job on scanned content `gmail_read`
  returns; the pack adds no second model call of its own.
- Gmail actions ride each job's Governor caps like every other tool;
  the pack introduces no separate spend meter.
