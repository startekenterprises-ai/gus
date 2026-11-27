/**
 * Rule proposals for the Gmail cleanup layer (MVP chunk 4) — the
 * "these senders look like bulk mail and aren't in your rules yet"
 * half of the plan's morning-report vision, kept deliberately
 * inert until the operator acts.
 *
 * How it works: after a cleanup cycle (and on the operator's
 * demand via `cleanup proposals generate`), a deterministic,
 * metadata-only scan tallies the inbox senders that NO rule
 * matched. A sender becomes a proposal only when the bulk signal
 * is strong: at least PROPOSAL_MIN_COUNT unmatched messages, at
 * least half of them carrying one of Gmail's own bulk category
 * labels (Promotions / Social / Updates / Forums). The same
 * protections selection applies are applied here first — starred,
 * IMPORTANT, unread, never-archive senders, and known
 * correspondents are never proposed — and, when a Shield scanner
 * is wired, a message whose snippet the gate blocks counts for
 * nothing. No model calls anywhere: the heuristic is counts and
 * labels, exactly like the selector.
 *
 * A proposal is DATA — a record in
 * <state>/gmail-cleanup-proposals.json (0600) holding the full
 * rule it proposes plus its evidence. It has no effect on any
 * cycle, dry run, or archive until the operator accepts it.
 * Accepting appends the rule to the operator's rule file — but
 * only after the RESULTING file passes the same loadCleanupRules
 * validation the engine loads with, checked on a temp file so a
 * bad accept leaves the real rule file byte-identical and the
 * proposal still pending (fail closed). Rejecting is final: a
 * rejected sender is never proposed again. Resolved proposals
 * stay in the file as the audit trail.
 *
 * Because accepting edits the rule file, it also changes the rule
 * file's hash — dry-run manifests made under the old file stop
 * matching it, exactly as with any hand edit (chunk 2's rule).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Hex } from "@gus/gate";
import {
  cleanupRuleMatches,
  loadCleanupRules,
  neverSenderMatches,
  type CleanupTransport,
  type GmailCleanupRule,
  type GmailCleanupRuleFile,
} from "./gmail-cleanup.js";
import {
  HttpGmailTransport,
  GMAIL_OAUTH_SECRET,
  type GmailDirectory,
  type GmailHttpFetch,
  type GmailShieldScanner,
  type GmailTransport,
} from "./gmail.js";
import type { VaultBroker } from "@gus/vault";

// ------------------------------------------------------------------ tuning

/** Unmatched messages from one sender before it can be proposed. */
export const PROPOSAL_MIN_COUNT = 3;
/** New proposals a single generation pass may add. */
export const PROPOSAL_MAX_NEW = 10;
/** Gmail's own bulk classifications — the "looks like bulk mail"
 *  half of the proposal signal. */
const BULK_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];

// ------------------------------------------------------------------- types

export interface GmailCleanupProposalEvidence {
  sender: string;
  /** Unmatched, unprotected messages observed from this sender. */
  count: number;
  /** Of those, how many carry a bulk category label. */
  bulkCount: number;
  /** Up to three sample subjects, oldest first — the manifest
   *  precedent: metadata in a 0600 operator file, shown only on
   *  operator surfaces. */
  sampleSubjects: string[];
  oldestDate: string;
  newestDate: string;
}

export interface GmailCleanupProposal {
  /** Deterministic per sender — regeneration finds the same
   *  record instead of piling up duplicates. */
  id: string;
  createdAt: number;
  updatedAt: number;
  status: "pending" | "accepted" | "rejected";
  resolvedAt?: number;
  /** The full rule accepting this proposal appends. */
  rule: GmailCleanupRule;
  evidence: GmailCleanupProposalEvidence;
}

export interface GmailCleanupProposalsFile {
  version: 1;
  proposals: GmailCleanupProposal[];
}

export function cleanupProposalsPath(stateDir: string): string {
  return join(stateDir, "gmail-cleanup-proposals.json");
}

export function proposalIdFor(sender: string): string {
  return `prop-${sha256Hex(sender).slice(0, 12)}`;
}

// ------------------------------------------------------------------- store

/** The proposals file: <state>/gmail-cleanup-proposals.json,
 *  0600 like the manifests it sits beside.
 *
 *  v0.24.0 (store hardening): saves are ATOMIC — write to a temp
 *  file, then rename over the real one (the scheduler-config
 *  pattern), so a crash mid-save leaves the previous complete
 *  file, never a torn one. Loads RECOVER: a missing file is the
 *  empty set (as always), and a corrupt one — invalid JSON, no
 *  proposals list, a malformed record — is quarantined (renamed
 *  aside as `<file>.corrupt-<timestamp>`, never deleted, so the
 *  audit trail survives for the operator to inspect) and the
 *  store starts clean rather than crashing every cycle that
 *  touches it. This replaces the old throw-loudly load: a torn
 *  write once wedged the store permanently, and the morning
 *  report depends on this state. The accept path's fail-closed
 *  property is unchanged where it matters — accepting still
 *  validates the resulting RULE file through loadCleanupRules
 *  before anything replaces it; a recovered (empty) store simply
 *  has no proposal to accept. */
export class GmailCleanupProposalStore {
  constructor(private path: string) {}

  load(): GmailCleanupProposalsFile {
    if (!existsSync(this.path)) return { version: 1, proposals: [] };
    let parsed: Partial<GmailCleanupProposalsFile>;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<GmailCleanupProposalsFile>;
    } catch {
      return this.recoverCorrupt();
    }
    if (!parsed || !Array.isArray(parsed.proposals)) {
      return this.recoverCorrupt();
    }
    for (const p of parsed.proposals) {
      if (
        !p ||
        typeof p.id !== "string" ||
        (p.status !== "pending" && p.status !== "accepted" && p.status !== "rejected") ||
        !p.rule ||
        typeof p.rule.name !== "string" ||
        !p.evidence ||
        typeof p.evidence.sender !== "string"
      ) {
        return this.recoverCorrupt();
      }
    }
    return { version: 1, proposals: parsed.proposals };
  }

  /** Quarantine a corrupt proposals file and start clean. The
   *  bad file is renamed aside — evidence preserved, nothing
   *  silently destroyed — and the empty set is returned. If the
   *  rename itself fails (the file vanished in a race, the
   *  directory is read-only), starting clean still stands: the
   *  next save replaces the file atomically. */
  private recoverCorrupt(): GmailCleanupProposalsFile {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let aside = `${this.path}.corrupt-${stamp}`;
    // Never overwrite an earlier quarantine: two corruptions in
    // the same millisecond get distinct asides.
    for (let n = 2; existsSync(aside); n++) aside = `${this.path}.corrupt-${stamp}-${n}`;
    try {
      renameSync(this.path, aside);
    } catch {
      /* starting clean does not depend on the quarantine landing */
    }
    return { version: 1, proposals: [] };
  }

  save(file: GmailCleanupProposalsFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Atomic (tmp + rename, the scheduler-config pattern): a
    // crash mid-save leaves the previous complete file, never a
    // torn one the next load would have to recover from.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  pending(): GmailCleanupProposal[] {
    return this.load().proposals.filter((p) => p.status === "pending");
  }
}

// -------------------------------------------------------------- generation

export interface GenerateCleanupProposalsOpts {
  directory: GmailDirectory;
  shield?: GmailShieldScanner;
  now?: () => number;
  scanLimit?: number;
}

interface SenderTally {
  sender: string;
  count: number;
  bulkCount: number;
  subjects: string[];
  oldestTs: number;
  newestTs: number;
  oldestDate: string;
  newestDate: string;
}

/**
 * One proposal generation pass over the mailbox's metadata.
 * Reads only — search is the sole transport call, so generation
 * cannot change the mailbox, and nothing it writes (the proposals
 * file) can change any future run either: only `accept` writes
 * the rule file. Returns the pending proposals after the pass.
 */
export async function generateCleanupProposals(
  transport: CleanupTransport,
  rules: GmailCleanupRuleFile,
  store: GmailCleanupProposalStore,
  opts: GenerateCleanupProposalsOpts,
): Promise<GmailCleanupProposal[]> {
  const now = (opts.now ?? (() => Date.now()))();
  const summaries = await transport.search("", opts.scanLimit ?? 1000);
  const inbox = summaries.filter((m) => m.labelIds.includes("INBOX"));
  // The selector's deterministic order (oldest first, id
  // tiebreak) — sample subjects and date ranges are stable
  // across passes over the same mailbox.
  const sorted = [...inbox].sort((a, b) => {
    const ta = Date.parse(a.date);
    const tb = Date.parse(b.date);
    const ka = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
    const kb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
    return ka - kb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  const tallies = new Map<string, SenderTally>();
  for (const msg of sorted) {
    // Covered already — a proposal exists to name what the rules
    // DON'T reach.
    if (rules.rules.some((r) => cleanupRuleMatches(r, msg, now))) continue;
    // The selection protections, applied before counting: mail
    // the engine would refuse to archive is never proposed.
    if (msg.labelIds.includes("STARRED") || msg.labelIds.includes("IMPORTANT")) continue;
    if (msg.labelIds.includes("UNREAD")) continue;
    if (neverSenderMatches(msg.from, rules.neverArchiveSenders)) continue;
    if (opts.directory.isKnown(msg.from)) continue;
    if (opts.shield) {
      const d = await opts.shield.scanSurface(
        "tool-result",
        "gmail-cleanup-proposals",
        `From: ${msg.from}\nSubject: ${msg.subject}\n${msg.snippet}`,
      );
      if (d.action === "block") continue;
    }
    let t = tallies.get(msg.from);
    if (!t) {
      t = {
        sender: msg.from,
        count: 0,
        bulkCount: 0,
        subjects: [],
        oldestTs: Number.POSITIVE_INFINITY,
        newestTs: Number.NEGATIVE_INFINITY,
        oldestDate: msg.date,
        newestDate: msg.date,
      };
      tallies.set(msg.from, t);
    }
    t.count++;
    if (msg.labelIds.some((l) => BULK_LABELS.includes(l))) t.bulkCount++;
    if (t.subjects.length < 3 && !t.subjects.includes(msg.subject)) t.subjects.push(msg.subject);
    const ts = Date.parse(msg.date);
    if (!Number.isNaN(ts)) {
      if (ts < t.oldestTs) {
        t.oldestTs = ts;
        t.oldestDate = msg.date;
      }
      if (ts > t.newestTs) {
        t.newestTs = ts;
        t.newestDate = msg.date;
      }
    }
  }

  const candidates = [...tallies.values()]
    .filter((t) => t.count >= PROPOSAL_MIN_COUNT && t.bulkCount * 2 >= t.count)
    .sort((a, b) => b.count - a.count || (a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : 0));

  const file = store.load();
  const byId = new Map(file.proposals.map((p) => [p.id, p]));
  let added = 0;
  for (const t of candidates) {
    const id = proposalIdFor(t.sender);
    const existing = byId.get(id);
    if (existing) {
      // A pending record refreshes its evidence; an accepted or
      // rejected one is final — a rejected sender is never
      // proposed again, and an accepted one is a rule now (its
      // mail matches, so it should not even be a candidate).
      if (existing.status === "pending") {
        existing.evidence = {
          sender: t.sender,
          count: t.count,
          bulkCount: t.bulkCount,
          sampleSubjects: t.subjects,
          oldestDate: t.oldestDate,
          newestDate: t.newestDate,
        };
        existing.updatedAt = now;
      }
      continue;
    }
    if (added >= PROPOSAL_MAX_NEW) continue;
    const proposal: GmailCleanupProposal = {
      id,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      rule: { name: `proposed: ${t.sender}`, from: [t.sender] },
      evidence: {
        sender: t.sender,
        count: t.count,
        bulkCount: t.bulkCount,
        sampleSubjects: t.subjects,
        oldestDate: t.oldestDate,
        newestDate: t.newestDate,
      },
    };
    file.proposals.push(proposal);
    byId.set(id, proposal);
    added++;
  }
  store.save(file);
  return file.proposals.filter((p) => p.status === "pending");
}

// ------------------------------------------------------------ accept/reject

/**
 * Accept a proposal: append its rule to the operator's rule file.
 * The candidate file is validated through loadCleanupRules — the
 * exact loader the engine uses — on a temp file FIRST; only a
 * clean validation replaces the real file (atomically, by
 * rename). Any failure leaves the rule file byte-identical and
 * the proposal pending. Returns the resolved proposal.
 */
export function acceptCleanupProposal(
  stateDir: string,
  proposalId: string,
  now: () => number = () => Date.now(),
): { proposal: GmailCleanupProposal; rulesPath: string } {
  const store = new GmailCleanupProposalStore(cleanupProposalsPath(stateDir));
  const file = store.load();
  const proposal = file.proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    throw new Error(`gmail cleanup proposals: no proposal "${proposalId}" — list them with: gmail-admin cleanup proposals list`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`gmail cleanup proposals: proposal ${proposalId} is already ${proposal.status} — only a pending proposal can be accepted`);
  }
  const rulesPath = join(stateDir, "gmail-cleanup-rules.json");
  let candidate: Record<string, unknown>;
  if (existsSync(rulesPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(rulesPath, "utf8"));
    } catch {
      throw new Error(`gmail cleanup proposals: the rule file at ${rulesPath} is not valid JSON — fix it before accepting proposals (nothing was changed)`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`gmail cleanup proposals: the rule file at ${rulesPath} is not a JSON object — fix it before accepting proposals (nothing was changed)`);
    }
    candidate = { ...(parsed as Record<string, unknown>) };
  } else {
    candidate = { version: 1, nightlyCap: 200, neverArchiveSenders: [], rules: [] };
  }
  const existingRules = Array.isArray(candidate.rules) ? candidate.rules : [];
  candidate.rules = [...existingRules, structuredClone(proposal.rule)];

  const tmpPath = `${rulesPath}.tmp-proposal`;
  writeFileSync(tmpPath, JSON.stringify(candidate, null, 2) + "\n", { mode: 0o600 });
  try {
    loadCleanupRules(tmpPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* the temp file is scratch; a leftover is untidy, not wrong */
    }
    throw new Error(
      `gmail cleanup proposals: accepting ${proposalId} would produce an invalid rule file (${e instanceof Error ? e.message : String(e)}) — the rule file was NOT changed and the proposal stays pending`,
    );
  }
  renameSync(tmpPath, rulesPath);
  chmodSync(rulesPath, 0o600);

  proposal.status = "accepted";
  proposal.resolvedAt = now();
  proposal.updatedAt = now();
  store.save(file);
  return { proposal, rulesPath };
}

/** Reject a proposal: final. The record stays as the audit trail
 *  and the sender is never proposed again. */
export function rejectCleanupProposal(
  stateDir: string,
  proposalId: string,
  now: () => number = () => Date.now(),
): GmailCleanupProposal {
  const store = new GmailCleanupProposalStore(cleanupProposalsPath(stateDir));
  const file = store.load();
  const proposal = file.proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    throw new Error(`gmail cleanup proposals: no proposal "${proposalId}" — list them with: gmail-admin cleanup proposals list`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`gmail cleanup proposals: proposal ${proposalId} is already ${proposal.status} — only a pending proposal can be rejected`);
  }
  proposal.status = "rejected";
  proposal.resolvedAt = now();
  proposal.updatedAt = now();
  store.save(file);
  return proposal;
}

// ------------------------------------------------------------- operator CLI

export interface GmailCleanupProposalsAdminDeps {
  vault: VaultBroker;
  directory: GmailDirectory;
  stateDir: string;
  /** Injected in tests (the mock); production builds the live
   *  transport from the vault. */
  transport?: GmailTransport;
  shield?: GmailShieldScanner;
  http?: GmailHttpFetch;
  now?: () => number;
}

function formatProposal(p: GmailCleanupProposal): string[] {
  const lines: string[] = [];
  lines.push(
    `${p.id} — ${p.evidence.sender}: ${p.evidence.count} unmatched messages (${p.evidence.bulkCount} bulk-labelled), ${p.evidence.oldestDate} → ${p.evidence.newestDate}`,
  );
  lines.push(`  proposed rule: "${p.rule.name}" — archive from ${(p.rule.from ?? []).join(", ")}`);
  if (p.evidence.sampleSubjects.length) {
    lines.push(`  samples: ${p.evidence.sampleSubjects.map((s) => `"${s}"`).join("; ")}`);
  }
  return lines;
}

/**
 * The proposals operator surface, reached as
 * `node main.js gmail-admin cleanup proposals <list|generate|accept <id>|reject <id>>`.
 * (main.ts routes the `proposals` segment here, the `schedule`
 * precedent.) Operator-only, like every cleanup surface. Nothing
 * here can archive mail: list/accept/reject touch only the
 * proposals and rule files, and generate only reads the mailbox.
 */
export async function runGmailCleanupProposalsAdmin(argv: string[], deps: GmailCleanupProposalsAdminDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const stateDir = deps.stateDir;
  const store = new GmailCleanupProposalStore(cleanupProposalsPath(stateDir));
  const now = deps.now ?? (() => Date.now());
  try {
    switch (cmd) {
      case "list": {
        const file = store.load();
        const pending = file.proposals.filter((p) => p.status === "pending");
        const accepted = file.proposals.filter((p) => p.status === "accepted").length;
        const rejected = file.proposals.filter((p) => p.status === "rejected").length;
        if (pending.length === 0) console.log("no pending cleanup rule proposals");
        for (const p of pending) for (const line of formatProposal(p)) console.log(line);
        console.log(`(${accepted} accepted, ${rejected} rejected — resolved proposals are never re-proposed)`);
        return 0;
      }
      case "generate": {
        if (!deps.transport && !deps.vault.has(GMAIL_OAUTH_SECRET)) {
          console.error("gmail cleanup proposals: the Gmail pack is not set up — no gmail-oauth credential in the vault (see docs/gmail-pack.md)");
          return 1;
        }
        const transport: CleanupTransport = deps.transport ?? new HttpGmailTransport(deps.vault, deps.http);
        const { rules } = loadCleanupRules(join(stateDir, "gmail-cleanup-rules.json"));
        const pending = await generateCleanupProposals(transport, rules, store, {
          directory: deps.directory,
          shield: deps.shield,
          now: deps.now,
        });
        console.log(`gmail cleanup proposals: ${pending.length} pending after this scan`);
        for (const p of pending) console.log(`  ${p.id} — ${p.evidence.sender} (${p.evidence.count} unmatched messages)`);
        console.log("nothing was archived and no rule changed — a proposal takes effect only when accepted");
        return 0;
      }
      case "accept": {
        const id = rest[0];
        if (!id) {
          console.error("usage: gmail-admin cleanup proposals accept <proposal id>");
          return 2;
        }
        const { proposal, rulesPath } = acceptCleanupProposal(stateDir, id, now);
        console.log(`accepted ${proposal.id}: rule "${proposal.rule.name}" (from ${proposal.evidence.sender}) appended to ${rulesPath}`);
        console.log("the rule takes effect on the next dry run or nightly cycle; manifests from earlier dry runs no longer match the changed rule file — dry-run again before archiving");
        return 0;
      }
      case "reject": {
        const id = rest[0];
        if (!id) {
          console.error("usage: gmail-admin cleanup proposals reject <proposal id>");
          return 2;
        }
        const proposal = rejectCleanupProposal(stateDir, id, now);
        console.log(`rejected ${proposal.id} (${proposal.evidence.sender}) — it was never applied and will not be proposed again`);
        return 0;
      }
      default:
        console.error("usage: gmail-admin cleanup proposals <list|generate|accept <id>|reject <id>>");
        return 2;
    }
  } catch (e) {
    console.error(`gmail-admin cleanup proposals: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
