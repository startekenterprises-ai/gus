/**
 * Panel help registry (v0.5.1) — the ONE source of truth for what
 * every panel setting does, in plain language.
 *
 * Each entry serves two surfaces from the same text, so the two can
 * never drift apart:
 *   - page.ts renders a "?" marker beside the setting; hovering or
 *     tapping it shows the entry's `tip` in a pop-up with a
 *     "More in Help" link.
 *   - the /help page (HELP_HTML below, served by server.ts under the
 *     same operator-token auth as everything else) prints every
 *     entry's `body` under an anchor matching the entry id —
 *     /help#<id> is where the pop-up's link lands.
 *
 * Copy rules (the product's honesty discipline, applied to docs):
 * plain sentences, concrete behavior, and the floors stated as
 * floors — vault reads, deletes, installs, sends and posts, git
 * push, sudo/kill-class shell, and keychain access are NEVER
 * delegable, and the spend caps never relax for anyone.
 */

export interface HelpEntry {
  /** Stable anchor id — also the /help#<id> fragment. */
  id: string;
  title: string;
  /** 1–2 plain sentences for the hover/tap pop-up. */
  tip: string;
  /** The docs text: one or two short paragraphs, "\n\n"-separated. */
  body: string;
}

export const HELP_ENTRIES: HelpEntry[] = [
  {
    id: "kill-switch",
    title: "Kill switch",
    tip: "Stops GUS immediately: no new model calls, and any running job ends as failed-loudly with a receipt. It is the same switch as Telegram's /stop — one flag, every surface.",
    body:
      "The kill switch is a single flag in the Governor that every surface reads — this panel, Telegram's /stop, and the app's menu all move the same switch. While it is on, the control plane starts no model calls and settles any running job as failed-loudly, with a receipt, rather than letting it trail off.\n\n" +
      "It deletes nothing and changes nothing else: jobs, receipts, the vault, your caps and your settings all stay exactly as they were. Resume with the button here (or /resume) when you want GUS back.",
  },
  {
    id: "governor-mode",
    title: "Governor mode",
    tip: "Enforcing: Shield verdicts and approval parks bind. Permissive: everything is still scanned, classified, capped and receipted, but blocks and parks are recorded instead of enforced — the troubleshooting mode.",
    body:
      "Enforcing is the normal mode: when the Agent-Shield gate blocks something, it stays blocked, and when an action is risky enough to need your approval, the job parks until you answer.\n\n" +
      "Permissive (SELinux-style) keeps every check — scanning, classification, spend caps, receipts — but records blocks and parks instead of enforcing them, and keeps a report of what it let through. Two floors never relax in either mode: vault reads stay denied, and the spend caps and the kill switch are unchanged. Approval delegation (below) only has any effect while the Governor is permissive.",
  },
  {
    id: "approval-delegation",
    title: "Approval delegation",
    tip: "Permissive mode only: a parked action can be routed to an agent approver instead of proceeding on the mode's say-so. In Enforcing mode none of this applies — approvals stay with you, exactly as always.",
    body:
      "With the Governor in Permissive mode, you can let some parked actions be decided by an agent instead of you: GUS itself, deciding with one metered model call in the control plane, or a named delegate resolving a park on a job it did not submit. Every delegated approval is hash-bound to the exact action, single-use, rate-limited, and receipted with who approved it and the reason they gave.\n\n" +
      "Some classes are floors and are never delegable, in any mode, under any setting: vault reads, deletes, installs, sends and posts, git push, sudo/kill-class shell, and keychain access. Flipping the Governor back to Enforcing takes the whole delegation back at once.",
  },
  {
    id: "del-gus-delegates",
    title: "GUS approves delegates' jobs",
    tip: "GUS may approve parked actions on jobs a delegate submitted. The decision is one model call made in the control plane — and a failed or unparseable decision counts as a denial.",
    body:
      "Delegates (like the Nova bridge) can hand GUS work but could never get a parked action past you. With this on — and the Governor permissive — a park on a delegate's job is offered to GUS first: the configured model sees the exact action and answers approve or deny, with a reason that lands on the receipt.\n\n" +
      "The decision call is metered against the same spend caps as any other model call, and anything that goes wrong with it — no provider, an error, a reply that doesn't parse — is a denial, never a shrug. Parks that fall outside the scope setting below are never offered to GUS at all.",
  },
  {
    id: "del-gus-own",
    title: "GUS approves its own jobs",
    tip: "GUS may approve parked actions on its own jobs. This is the only self-approval path in GUS, it exists only in Permissive mode, and it is off unless you tick this box.",
    body:
      "Normally the agent asking for an action is never the one who approves it — that separation is the point of the approval system. This setting is the deliberate, narrow exception: in Permissive mode only, GUS may also resolve parks on jobs it submitted itself, under the same scope and rate limits as any other agent approval.\n\n" +
      "It is off by default, every such approval is receipted as GUS approving its own action (nothing is disguised as an operator decision), and the floors still hold: GUS can never approve its own deletes, installs, sends, git pushes, vault reads, sudo-class shell, or keychain access.",
  },
  {
    id: "del-delegates",
    title: "Delegates may approve",
    tip: "A named delegate may approve a parked action on a job it did NOT submit. A delegate approving its own job is never allowed — that rule has no setting.",
    body:
      "With this on — and the Governor permissive — a delegate who is handed an approval (in the group chat or the panel) may resolve a park on someone else's job: yours, GUS's, or another delegate's. The resolution is checked again at the moment it lands, so a press alone grants nothing.\n\n" +
      "The one rule that never bends: a delegate can never approve its own submitted job, even with this on. Self-approval is reserved to GUS itself, and only via the separate setting above.",
  },
  {
    id: "del-scope",
    title: "Delegation scope",
    tip: "Bounded: only Mac input injection, file writes outside the work folders, and non-allowlisted shell may be agent-approved. Everything except the floors: any parked class except the ones that are never delegable.",
    body:
      "Scope decides which parked action classes an agent approver may even be offered. Bounded keeps it to the everyday driving actions: clicking, typing and other Mac input injection; writes to files outside the approved work folders; and shell commands that aren't on the allowlist.\n\n" +
      "Everything except the floors widens that to any class that can park — with the floors still carved out, always: vault reads, deletes, installs, sends and posts, git push, sudo/kill-class shell, and keychain access are never delegable under either scope.",
  },
  {
    id: "del-max-approvals",
    title: "Max agent approvals per hour",
    tip: "A rate limit across all agent approvers combined. When the hour's budget is used up, parks come back to you — nothing is approved by default.",
    body:
      "Delegated approvals are counted over a rolling hour, across GUS and every delegate together. Once the count reaches this number, new parks are no longer routed to agent approvers; they wait for you like any Enforcing-mode park.\n\n" +
      "Set it to 0 to switch agent approvals off without unticking the boxes above. Your own approvals are never counted and never limited.",
  },
  {
    id: "provider",
    title: "Provider",
    tip: "Whose model GUS thinks with. Your key is stored in the encrypted vault and metered by the same caps as everything else; Ollama runs on your own machine and costs $0.",
    body:
      "The provider is the model service behind GUS's thinking — Gemini, Anthropic, OpenAI, a model on your own machine via Ollama, or the StarTek starter gateway where configured. The offline stub is a test double, not a real model.\n\n" +
      "Your API key goes straight into the encrypted vault on this machine when you save; it is never shown again, never logged, and never sent anywhere except the provider's own endpoint at call time. One honest catch: on Google's free Gemini tier, Google may use what you send to improve its models — a paid key removes that.",
  },
  {
    id: "model",
    title: "Model",
    tip: "The exact model GUS calls for the chosen provider. Use the name exactly as the provider spells it — a wrong name fails loudly at call time, it never silently falls back.",
    body:
      "Each provider names its models its own way, and GUS passes the name through unchanged. The Governor meters every call against your spend caps using its per-model price table, so the model choice is also a cost choice: a bigger model spends the same caps faster.\n\n" +
      "Changing the model takes effect on the next job — no restart, and jobs already running keep the model they started with.",
  },
  {
    id: "cap-per-task",
    title: "Spend cap — per task",
    tip: "The most a single job may spend, ever. A job that reaches it is stopped and settled failed-loudly. The cap is enforced by the Governor outside the model — no prompt, approval, or delegation can raise it.",
    body:
      "Every model call a job makes is reserved against this ceiling before it runs. A job that would spend past it is cut off and ends as failed-loudly with a receipt showing where the money went — it cannot borrow from tomorrow's budget or argue its way past.\n\n" +
      "Only you can change caps, here or via the setup step. Agent approvers under the delegation policy can approve actions, never spending: the caps bind them exactly as they bind the agent.",
  },
  {
    id: "cap-per-day",
    title: "Spend cap — per day",
    tip: "The most GUS may spend across all jobs in a day. When it's reached, new paid work waits for tomorrow — the day cap binds delegates' jobs and GUS's own approval decisions too.",
    body:
      "The daily ceiling is the Governor's running total of settled spend for the day, across every job and every conversation — including jobs submitted by delegates and the metered calls GUS makes when it decides a delegated approval.\n\n" +
      "Reaching it doesn't break anything mid-flight: running jobs settle what they've reserved, and new paid work is refused until the day rolls over. Only you can change it.",
  },
  {
    id: "cap-per-month",
    title: "Spend cap — per month",
    tip: "The most GUS may spend in a month, across everything. The outermost ceiling: per-task and per-day caps can be loose, this one still stops a slow leak.",
    body:
      "The monthly ceiling catches what the smaller caps can't: a modest daily spend, left running, is real money by month's end. The Governor totals settled spend for the month and refuses new paid work once the ceiling is reached.\n\n" +
      "Like every cap, it is enforced outside the model, applies to delegate-submitted work and approval decisions alike, and can only be changed by you.",
  },
  {
    id: "panel-chat",
    title: "Chat",
    tip: "Talk to GUS from the panel. A chat message is a normal job: secret-guard, Shield ingress scan, classifier, the same spend caps, the same receipts. The chat window is a channel, not a bypass.",
    body:
      "The Chat view is the panel acting as one more channel, like Telegram: what you type is screened for secrets, scanned by the Agent-Shield gate before it can reach the agent, classified, metered against your caps, and settled with a receipt. Nothing about coming from this page relaxes any of that — a message the gate would block on Telegram is blocked here, with the same receipt.\n\n" +
      "The conversation is kept in durable state on this machine, so a reload loses nothing, and Telegram keeps working in parallel — same jobs, two windows. When a chat job parks for approval, the card appears right in the conversation and resolves through the same hash-bound, single-use approval engine as every other surface.",
  },
  {
    id: "panel-watch",
    title: "Watch",
    tip: "See the resident Mac while GUS works: the latest screen frame beside the timeline of actions and gate decisions. Frames are fetched only while the view is open, served only on this machine, and never stored.",
    body:
      "The Watch view asks the Mac bridge for a fresh observation — the same observation path GUS itself uses — at most about once a second, and only while you are looking. Nothing is captured in the background, frames are never written to disk or sent anywhere, and pausing the view stops the requests entirely.\n\n" +
      "The frame needs the Screen Recording permission macOS grants to GUS.app. Without it the frame area says so plainly and the view still shows the timeline: every action, park, approval and gate decision from the durable event and gate logs, each line traceable to its receipt where one exists.",
  },
  {
    id: "voice-call",
    title: "Voice — Call GUS",
    tip: "Talk to GUS in a live call and hear the answer as it's spoken. Your words are transcribed by your own local speech service and then treated exactly like a typed message: same secret-guard, Shield scan, caps and receipts. Voice is a channel, not a bypass.",
    body:
      "The Call button opens a live call: the microphone is on only while the call is open, your speech streams to the voice channel in the control plane, and a pause ends your turn. Your transcription service (an OpenAI-compatible endpoint you run — faster-whisper by default) turns each turn into text on your own machine; from that moment the transcript is an ordinary channel message and everything that applies to typed text applies to it, including a Shield block with its receipt. The reply is spoken by your text-to-speech service (Kokoro by default) sentence by sentence, so it starts talking before the whole reply exists — and if you talk over it, the speech cuts off and listens (that's barge-in; it stops the talking, never a running job). If a speech service fails, the reply still reaches you as text, with the failure stated plainly. A call ends when you hang up, after three minutes of silence, or at sixty minutes — and every turn's stage timings (heard, thought, spoke) are kept in the call record, so 'is local fast enough?' is a measurement, not an opinion.\\n\\n" +
      "Approvals by voice are deliberately narrow. When a job parks, you hear the exact summary from the approval record read back. Only an exact \"confirm\" or \"yes, do it\" runs it, only an exact \"no\" denies it, and anything else — including a plain \"yes\" — runs nothing and leaves the park waiting. \"Stop\" or \"GUS stop\" trips the same kill switch as typing /stop and ends the call. Voice never approves silently, and a spoken prompt injection is scanned and blocked like any other.",
  },
];

export const HELP_BY_ID: ReadonlyMap<string, HelpEntry> = new Map(
  HELP_ENTRIES.map((e) => [e.id, e]),
);

/** HTML-escape for both text nodes and double-quoted attribute
 *  values (the page embeds tips in data attributes). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The "?" marker page.ts places beside a setting. Carries the tip in
 * a data attribute so the page's pop-up works with no extra fetch;
 * the link inside the pop-up points at /help#<id>.
 */
export function helpMark(id: string): string {
  const entry = HELP_BY_ID.get(id);
  if (!entry) return "";
  return (
    `<button type="button" class="helpbtn" data-help="${entry.id}" ` +
    `data-tip="${escapeHtml(entry.tip)}" aria-label="Help: ${escapeHtml(entry.title)}">?</button>`
  );
}

/** The /help page — every registry entry, anchors matching the ids.
 *  Same self-contained idiom as the panel page: inline CSS, no
 *  external assets. */
export const HELP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GUS — help &amp; docs</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 880px; padding: 16px; line-height: 1.45; }
  h1 { font-size: 1.4rem; margin: 0 0 2px; }
  h2 { font-size: 1.1rem; margin: 28px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  .sub { opacity: .75; font-size: .9rem; }
  a { color: inherit; }
  section { scroll-margin-top: 12px; }
</style>
</head>
<body>
<h1>GUS help &amp; docs</h1>
<div class="sub">What every setting on the <a href="/">control panel</a> does, in plain language. The same text as the ? pop-ups — one source, so they can't drift apart.</div>
${HELP_ENTRIES.map(
  (e) =>
    `<section id="${e.id}"><h2>${escapeHtml(e.title)}</h2>` +
    e.body
      .split("\n\n")
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join("") +
    `</section>`,
).join("\n")}
</body>
</html>
`;
