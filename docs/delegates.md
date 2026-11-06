# Delegate principals — letting another agent ask GUS for work

GUS normally serves one human in one private chat. A **delegate** is
a second, named agent identity that may *request* work in a shared
conversation — built for the Nova bridge, where the operator, GUS,
and Nova share a Telegram group.

## The line that does not move

| | operator | delegate | anyone else |
|---|---|---|---|
| submit job requests | ✅ | ✅ | ignored |
| approve / deny | ✅ | ❌ | ❌ |
| /stop, /resume, /update | ✅ | ❌ | ❌ |

A delegate's jobs run under the same classifier, Agent-Shield gate,
and spend caps as the operator's. Anything that would park for
approval parks for the **operator** — a delegate can never approve,
not even its own jobs. Every delegate request is prefixed with its
origin (`[from Nova] …`) in the job record and the runtime prompt,
so the receipts and the model both know who asked.

## Configuration

`~/.gus/state/delegates.json`, re-read per message (edits land with
no restart):

```json
{
  "conversations": {
    "-1001234567890": {
      "operatorId": "7572793265",
      "delegates": [{ "senderId": "123456789", "name": "Nova" }]
    }
  }
}
```

Keys are channel conversation ids (Telegram chat ids; group ids are
negative). Sender ids are channel user ids. A conversation with no
entry behaves exactly as GUS always has — the private-chat model,
where the only possible sender is the operator.

## Telegram group notes

- Both bots need **Group Privacy OFF** in BotFather, or they only
  see commands and mentions, not ordinary messages.
- Approval buttons render in the group; only the operator's tap
  resolves. A delegate's or stranger's tap is refused and logged
  (`approval_resolve_rejected`, reason `not-operator`).
- Strangers' messages are ignored and logged
  (`message_ignored_stranger`).

## The bridge inbox — how a bot delegate actually reaches GUS

Telegram does not deliver bot messages to other bots, in any
configuration (verified live 2026-11-05, both directions). A bot
delegate therefore cannot reach GUS through the group chat. The
last hop is a file: the delegate's operator-side tooling appends
one JSON file per request to `~/.gus/state/bridge-inbox/`, and the
control plane's bridge adapter turns each file into the same
channel event a chat message would have produced. Enable it with
a `bridge` binding in `delegates.json`:

```json
{ "bridge": { "conversationId": "-1001234567890", "senderId": "123456789" } }
```

Request file shape: `{ "id": "<unique>", "text": "<request>", "ts": <ms> }`,
named so lexical order is chronological. Processed files are
archived under `bridge-inbox/processed/` (malformed ones as
`.bad`). Replies, receipts, and approval buttons still post to the
conversation through Telegram — the group remains the room the
operator watches; only the delegate's inbound hop is a file.
