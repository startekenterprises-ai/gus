# Installing GUS, in plain English

GUS is an AI agent that runs on a computer you control. This guide
gets you from nothing to a working agent. You do not need to be a
programmer. You do need about ten minutes, most of it waiting for a
download.

## What you need

- A computer that stays on — a small server, a home machine, or a
  cheap rented one (a $5–10/month virtual server is plenty; GUS is
  built to fit in 1 GB of memory).
- **Docker** installed on that computer. Docker is the box GUS runs
  inside. If you don't have it, get it from docker.com — it's a
  normal install, like any other app.
- A phone with **Telegram** (free) if you want approvals and the kill
  switch in your pocket. The agent works without it; the safety
  buttons are just nicer with it.

## Step 1 — Start GUS

Open a terminal on the computer and run:

```sh
git clone <repo-url> gus && cd gus
npm install && npm run build && npm run pack
docker compose -f packages/sandbox/docker-compose.yml up --build -d
```

That is the only time you need the terminal. The last command builds
two boxes and starts them:

- the **control plane** — the part that holds your money limits, your
  passwords, and the rulebook. The agent can never reach inside it.
- the **sandbox** — where the agent itself works. It has no internet
  connection of its own and no passwords. Anything it needs from the
  outside world is fetched for it, checked, and handed over.

## Step 2 — Open the control panel

In your web browser, go to **http://127.0.0.1:8731**. That address
means "this same computer" — the panel is not open to the internet.

The panel asks for an **operator token**. That's a password GUS made
up for you on first start. It lives in a file named `panel-token`.
Read it with:

```sh
docker compose -f packages/sandbox/docker-compose.yml exec control-plane cat /state/panel-token
```

Copy it into the panel. Keep it like any password — whoever has it
can approve actions and see your spending ledger (they still can't
see your stored secrets; nobody can, including the agent).

## Step 3 — The five-step setup wizard

The panel walks you through five short steps. In the order they
appear:

1. **Connect Agent-Shield.** Agent-Shield is the security scanner
   that checks everything the agent reads and does. This step creates
   a free key for you automatically and locks it in the vault. One
   click.
2. **Connect Telegram** (optional but recommended). Create a bot by
   talking to Telegram's @BotFather (it takes a minute), then paste
   the bot token **into the panel — never into a chat**. From then
   on, approval requests and the stop button reach your phone.
   *Honest fine print: Telegram chats are not end-to-end encrypted,
   so GUS only ever sends approvals and summaries there — never
   secrets.*
3. **Pick a brain.** Choose which AI model service the agent uses:
   a Google Gemini key (the recommended starter — a free key from
   Google AI Studio is enough to begin), your own Anthropic or OpenAI
   key, a model running on your own machine (Ollama), or a starter
   gateway if one is offered. Keys go into the panel and straight
   into the encrypted vault. One honest catch: on Google's free tier,
   Google may use what you send to improve its models — a paid Gemini
   key removes that.
4. **Set your spending caps.** Pre-filled with starter limits —
   $2 per task, $10 per day, $100 per month. These are hard ceilings
   enforced outside the AI: when the money runs out, the work stops,
   full stop. Change them whenever you like, here in the panel.
5. **Run your first job.** GUS runs a short read-only digest so you
   can watch a job go from start to a signed "receipt" — proof of
   what happened, what it cost, and that a checker (not the agent
   itself) verified the result.

That's it. In testing, this whole wizard took **5 actions**.

## Day-to-day

- **Approvals.** When the agent wants to do something destructive —
  delete files, send something, spend over a threshold — it stops
  and asks. You get the exact action ("delete these 5 files") with
  Approve / Deny. Approving approves *that exact thing*, once. If you
  ignore it, the answer is no.
- **The kill switch.** `/stop` in Telegram, or the button in the
  panel, halts everything instantly and stays halted until you say
  `/resume`. The agent cannot talk its way past either.
- **Receipts.** Every finished job leaves a receipt in the panel:
  what ran, what it cost, what the security scan found. "Done" in GUS
  means a separate checker confirmed the result — not that the agent
  said so.
- **If GUS crashes or the computer reboots.** Work that was in
  progress is marked failed, loudly, with a receipt — never left
  pretending to still be running. Anything waiting for your approval
  stays waiting.

## Updating

Updates arrive as signed releases. GUS checks the signature, tries
the new version against your recorded automations *before* switching
to it, and rolls back by itself if anything fails. You get a message
before and after. Your data — the ledger, the vault, your approval
history — is never part of a rollback; only code and settings are.

## If something goes wrong

- Panel won't load? Check the boxes are running:
  `docker compose -f packages/sandbox/docker-compose.yml ps`
- Logs: `docker compose -f packages/sandbox/docker-compose.yml logs control-plane`
- Security problem to report? See `SECURITY.md` in the repository —
  please don't open a public issue for a vulnerability.
