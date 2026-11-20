/**
 * Memory Write Service — Memory Slice B (v0.13.0, R1 groundwork).
 *
 * Slice A made the context pack READ-ONLY on purpose: the pack is
 * data, never authority, and a model write path into the operator's
 * own memory files is the most sensitive surface GUS has — a bad
 * write does not just corrupt a file, it steers every future job
 * (the Poisoned-Memory drill pins the authority side; this service
 * is the integrity side). Slice B is the write loop, built as a
 * service over the MemoryStore contract (@gus/shared/stores.ts) so
 * the rules live in exactly one place no matter which surface calls
 * them — this module is deliberately NOT wired into the comm
 * server, the panel, or the channel host here; the coordinator
 * wires it, and every caller inherits the same discipline:
 *
 *  - NOTHING is written unscreened. Every text that could land in a
 *    core file or the candidate log passes the secret-guard first,
 *    and a hit is a REFUSAL, never a silent redaction: the
 *    operator's (or a job's) words are never quietly altered, and a
 *    secret is never stored — the refusal names the pattern CLASSES
 *    only, so the refusal itself cannot leak the value.
 *  - Agent proposals are CANDIDATES, not edits. A job (or the agent
 *    itself) may only propose; the text lands in a core file when
 *    the operator promotes it, possibly with the operator's own
 *    edited wording — the operator's wording always wins. Rejection
 *    is a status line, not a deletion: candidates.jsonl stays
 *    append-only, latest line per id wins.
 *  - Direct operator memory ("remember") is the one straight-to-
 *    file path, because the operator IS the authority over their
 *    own files — still screened, still evented (hash only).
 *  - Forget is two-phase and count-bound. Search shows the operator
 *    exactly which lines match; apply re-runs the search and
 *    refuses if the count moved, so what is removed is provably
 *    what was reviewed. Removed file lines are archived (auditable,
 *    recoverable), removed candidates become "rejected" status
 *    lines, and the single "forgotten" event carries content
 *    HASHES — proof of what left, without keeping the content in
 *    the log the operator asked to forget it from.
 *
 * Identity candidates are flagged, not blocked: promotion is the
 * operator's own act, so it proceeds — the result carries
 * identityCategory so the panel can make the operator look twice
 * at a change to who GUS is.
 */
import type {
  MemoryCandidate,
  MemoryCandidateCategory,
  MemoryStore,
} from "@gus/shared";
import { screenText, sha256Hex } from "./screen.js";

/** Core files a promotion may target. A candidate may never land
 *  anywhere else — not context.json (budgets/toggles are config,
 *  not memory), not a daily note, not an arbitrary path. */
const PROMOTE_TARGETS: readonly string[] = [
  "MEMORY.md",
  "OPERATOR.md",
  "PROJECTS.md",
  "IDENTITY.md",
  "SOUL.md",
];

/** The core files forget searches, in pack order. */
const FORGET_CORE_FILES: readonly string[] = [
  "IDENTITY.md",
  "SOUL.md",
  "OPERATOR.md",
  "MEMORY.md",
  "PROJECTS.md",
];

const CANDIDATE_CATEGORIES: readonly MemoryCandidateCategory[] = [
  "fact",
  "decision",
  "preference",
  "identity",
  "project",
];

/** Unknown categories coerce to "fact" — the same rule the store's
 *  defensive parse applies to lines read back from disk, so a
 *  category means the same thing on the way in as on the way out. */
function coerceCategory(v: unknown): MemoryCandidateCategory {
  return typeof v === "string" &&
    (CANDIDATE_CATEGORIES as readonly string[]).includes(v)
    ? (v as MemoryCandidateCategory)
    : "fact";
}

/** The operator's local calendar date (YYYY-MM-DD) for a timestamp —
 *  memory bullets are dated the way the operator experiences the
 *  day, not by UTC. */
function localDate(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** The refusal detail for a screened text: pattern classes only.
 *  The screened text itself is never echoed — not the original
 *  (it carries the secret) and not the redacted form (the refusal
 *  is a control message, not a storage surface). */
function secretRefusal(screened: ReturnType<typeof screenText>): string {
  const classes = [...new Set(screened.findings.map((f) => f.patternClass))];
  return (
    `That text looks like it contains a secret (${classes.join(", ")}), ` +
    "so nothing was saved. Remove the secret and try again — GUS never stores secrets in memory."
  );
}

let counter = 0;

/** Candidate ids, minted the way jobs.ts mints job ids: a
 *  time-ordered base-36 prefix plus a counter/random suffix, so ids
 *  sort roughly by creation and never collide within a process. */
function mintCandidateId(): string {
  return `mem_${Date.now().toString(36)}_${(counter++).toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/** One forget-search hit: a single line in a core file or daily
 *  note, or one pending candidate. `text` is the line, trimmed —
 *  exactly what forgetApply will remove (file lines) or reject
 *  (candidates). */
export interface ForgetMatch {
  where: "file" | "candidate";
  /** For file matches: the context-relative file name
   *  ("MEMORY.md", or "memory/2026-11-17.md" for a daily note). */
  file?: string;
  /** For candidate matches: the candidate's id. */
  candidateId?: string;
  text: string;
}

export class MemoryWriteService {
  constructor(private store: MemoryStore) {}

  // ---------------------------------------------------------- propose

  /**
   * Propose a memory candidate. The text is screened first: a
   * secret-shaped proposal is refused outright (classes named,
   * nothing appended) — a candidate log full of refused secrets
   * would itself become the leak. A clean proposal is stored
   * verbatim: "clean" means the guard found nothing, so there is
   * nothing to redact and the stored text is the proposer's exact
   * words, awaiting the operator's decision.
   */
  propose(input: {
    jobId?: string;
    origin: string;
    category?: string;
    text: string;
    source?: string;
    shieldReceiptId?: string;
  }): { ok: true; candidate: MemoryCandidate } | { ok: false; detail: string } {
    if (typeof input.text !== "string" || input.text.trim() === "") {
      return { ok: false, detail: "There is no text to propose — nothing was saved." };
    }
    const screened = screenText(input.text);
    if (!screened.clean) {
      return { ok: false, detail: secretRefusal(screened) };
    }
    const candidate: MemoryCandidate = {
      id: mintCandidateId(),
      ts: Date.now(),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      origin:
        typeof input.origin === "string" && input.origin
          ? input.origin
          : "agent-self",
      category: coerceCategory(input.category),
      text: input.text,
      source: typeof input.source === "string" ? input.source : "",
      status: "proposed",
      ...(input.shieldReceiptId
        ? { shieldReceiptId: input.shieldReceiptId }
        : {}),
    };
    this.store.appendCandidateLine({ ...candidate });
    this.store.appendEvent({
      kind: "candidate_proposed",
      id: candidate.id,
      ...(input.jobId ? { jobId: input.jobId } : {}),
    });
    return { ok: true, candidate };
  }

  /** All candidates, newest first. */
  listCandidates(): MemoryCandidate[] {
    return this.store
      .listCandidates()
      .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
  }

  /** Candidates still awaiting the operator's decision. */
  pendingCandidates(): MemoryCandidate[] {
    return this.listCandidates().filter((c) => c.status === "proposed");
  }

  // ---------------------------------------------------------- decisions

  /**
   * Promote a proposed candidate into a core file. The operator may
   * supply edited text (their wording wins over the proposal) and
   * an explicit target file (validated against the core files);
   * the default target follows the category — preferences belong
   * with the operator's standing facts in OPERATOR.md, everything
   * else in MEMORY.md. The final text is screened like every other
   * write. The decision is a new status line (append-only), and an
   * "identity" candidate is flagged in the result so the panel can
   * surface it — promotion still proceeds, because the operator is
   * the one promoting.
   */
  promote(
    id: string,
    opts?: { text?: string; targetFile?: string },
  ): { ok: boolean; detail: string; identityCategory?: boolean } {
    const candidate = this.store.listCandidates().find((c) => c.id === id);
    if (!candidate) {
      return {
        ok: false,
        detail: `No memory candidate with id ${id} was found — nothing was promoted.`,
      };
    }
    if (candidate.status !== "proposed") {
      return {
        ok: false,
        detail: `That candidate was already ${candidate.status}, so it cannot be promoted again.`,
      };
    }
    const text = opts?.text ?? candidate.text;
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, detail: "The promoted text is empty — nothing was written." };
    }
    const screened = screenText(text);
    if (!screened.clean) {
      return { ok: false, detail: secretRefusal(screened) };
    }
    let targetFile: string;
    if (opts?.targetFile !== undefined) {
      if (!PROMOTE_TARGETS.includes(opts.targetFile)) {
        return {
          ok: false,
          detail:
            `"${opts.targetFile}" is not a file a memory can be promoted into. ` +
            `Choose one of: ${PROMOTE_TARGETS.join(", ")}.`,
        };
      }
      targetFile = opts.targetFile;
    } else {
      targetFile = candidate.category === "preference" ? "OPERATOR.md" : "MEMORY.md";
    }
    const decidedAt = Date.now();
    this.store.appendCoreText(
      targetFile,
      `\n- ${localDate(decidedAt)} [candidate ${id}] ${text}\n`,
    );
    this.store.appendCandidateLine({
      ...candidate,
      status: "promoted",
      decidedBy: "operator",
      decidedAt,
      promotedTo: targetFile,
    });
    this.store.appendEvent({ kind: "candidate_promoted", id, file: targetFile });
    return {
      ok: true,
      detail: `Promoted into ${targetFile}: "${text}"`,
      ...(candidate.category === "identity" ? { identityCategory: true } : {}),
    };
  }

  /** Reject a proposed candidate: a status line, never a deletion —
   *  the proposal and its rejection both stay in the audit log. */
  reject(id: string): { ok: boolean; detail: string } {
    const candidate = this.store.listCandidates().find((c) => c.id === id);
    if (!candidate) {
      return {
        ok: false,
        detail: `No memory candidate with id ${id} was found — nothing was rejected.`,
      };
    }
    if (candidate.status !== "proposed") {
      return {
        ok: false,
        detail: `That candidate was already ${candidate.status}, so it cannot be rejected.`,
      };
    }
    const decidedAt = Date.now();
    this.store.appendCandidateLine({
      ...candidate,
      status: "rejected",
      decidedBy: "operator",
      decidedAt,
    });
    this.store.appendEvent({ kind: "candidate_rejected", id });
    return { ok: true, detail: `Rejected the candidate: "${candidate.text}"` };
  }

  // ---------------------------------------------------------- remember

  /**
   * The operator's own direct write: append a dated bullet to
   * MEMORY.md (or OPERATOR.md) and event its hash. Screened first,
   * like everything else — and on a screen hit the refusal is the
   * whole story: the operator's words are never silently altered
   * into a redacted version and saved behind their back.
   */
  remember(
    text: string,
    target: "MEMORY.md" | "OPERATOR.md" = "MEMORY.md",
  ): { ok: boolean; detail: string; file?: string } {
    if (target !== "MEMORY.md" && target !== "OPERATOR.md") {
      return {
        ok: false,
        detail: `"${target}" is not a file a direct memory can be written to — use MEMORY.md or OPERATOR.md.`,
      };
    }
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, detail: "There is no text to remember — nothing was saved." };
    }
    const screened = screenText(text);
    if (!screened.clean) {
      return { ok: false, detail: secretRefusal(screened) };
    }
    const date = localDate(Date.now());
    this.store.appendCoreText(target, `\n- ${date} [operator] ${text}\n`);
    this.store.appendEvent({
      kind: "remembered",
      file: target,
      sha256: sha256Hex(text),
    });
    return {
      ok: true,
      detail: `Remembered in ${target} — appended: - ${date} [operator] ${text}`,
      file: target,
    };
  }

  // ---------------------------------------------------------- forget

  /**
   * Find what a forget would remove, without removing anything:
   * every non-empty line containing the query (case-insensitive) in
   * the five core files and the daily notes, plus every PENDING
   * candidate whose text matches. Decided candidates are history —
   * forget does not rewrite decisions, it only stops pending
   * proposals from ever landing.
   */
  forgetSearch(query: string): { matches: ForgetMatch[] } {
    if (typeof query !== "string" || query.trim() === "") {
      return { matches: [] };
    }
    const needle = query.toLowerCase();
    const matches: ForgetMatch[] = [];
    const scanFile = (relPath: string, label: string): void => {
      const content = this.store.readContextFile(relPath);
      if (content === null) return;
      for (const line of content.split("\n")) {
        const text = line.trim();
        if (text !== "" && text.toLowerCase().includes(needle)) {
          matches.push({ where: "file", file: label, text });
        }
      }
    };
    for (const name of FORGET_CORE_FILES) scanFile(name, name);
    for (const name of this.store.dailyNoteNames()) {
      scanFile(`memory/${name}`, `memory/${name}`);
    }
    for (const candidate of this.store.listCandidates()) {
      if (
        candidate.status === "proposed" &&
        candidate.text.toLowerCase().includes(needle)
      ) {
        matches.push({
          where: "candidate",
          candidateId: candidate.id,
          text: candidate.text,
        });
      }
    }
    return { matches };
  }

  /**
   * Remove exactly what forgetSearch showed. The count is the
   * contract: apply re-runs the search and refuses when the match
   * count differs from `confirmCount` — the files changed since
   * the operator reviewed them, and removing a different set than
   * the one reviewed is exactly the failure this two-phase shape
   * exists to prevent. File lines are removed by re-filtering each
   * file with the same predicate the search used (so the removed
   * set is the searched set by construction), the survivors are
   * written back line-for-line, and the removed lines go to the
   * archive under a dated header. Candidate matches become
   * "rejected" status lines (decidedBy "operator-forget"). One
   * event records the count and the removed texts' hashes — proof
   * without content.
   */
  forgetApply(
    query: string,
    confirmCount: number,
  ): { ok: boolean; detail: string; removed?: number } {
    const { matches } = this.forgetSearch(query);
    if (matches.length !== confirmCount) {
      return {
        ok: false,
        detail:
          `The matches changed since you counted — search again. ` +
          `You confirmed ${confirmCount}, but the search now finds ${matches.length}; nothing was removed.`,
      };
    }
    if (matches.length === 0) {
      return {
        ok: false,
        detail: "That search matches nothing, so there is nothing to forget.",
      };
    }
    const needle = query.toLowerCase();
    const decidedAt = Date.now();

    // File matches: rewrite each touched file minus its matched
    // lines. The predicate is forgetSearch's own, re-applied per
    // line, so duplicates and whitespace variants behave exactly
    // as the search reported them.
    const removedLines: string[] = [];
    const touchedFiles = [
      ...new Set(
        matches
          .filter((m) => m.where === "file" && m.file)
          .map((m) => m.file as string),
      ),
    ];
    for (const file of touchedFiles) {
      const content = this.store.readContextFile(file);
      if (content === null) continue;
      const kept: string[] = [];
      for (const line of content.split("\n")) {
        const text = line.trim();
        if (text !== "" && text.toLowerCase().includes(needle)) {
          removedLines.push(text);
        } else {
          kept.push(line);
        }
      }
      this.store.writeCoreFile(file, kept.join("\n"));
    }
    if (removedLines.length > 0) {
      const header =
        `# Forgotten ${new Date(decidedAt).toISOString()} — ` +
        `${removedLines.length} line(s) removed by an operator forget (search: "${query}")\n`;
      this.store.appendArchiveText(
        `forget-${decidedAt}.md`,
        header + removedLines.map((l) => l + "\n").join(""),
      );
    }

    // Candidate matches: a forget is a decision, recorded like one.
    let candidatesRemoved = 0;
    const byId = new Map(this.store.listCandidates().map((c) => [c.id, c]));
    for (const match of matches) {
      if (match.where !== "candidate" || !match.candidateId) continue;
      const candidate = byId.get(match.candidateId);
      if (!candidate || candidate.status !== "proposed") continue;
      this.store.appendCandidateLine({
        ...candidate,
        status: "rejected",
        decidedBy: "operator-forget",
        decidedAt,
      });
      candidatesRemoved++;
    }

    const removed = removedLines.length + candidatesRemoved;
    this.store.appendEvent({
      kind: "forgotten",
      count: removed,
      hashes: matches.map((m) => sha256Hex(m.text)),
    });
    return {
      ok: true,
      detail:
        `Forgot ${removed} item(s) matching "${query}". ` +
        (removedLines.length > 0
          ? `The removed lines were archived (context/archive/forget-${decidedAt}.md) so the forget stays auditable.`
          : "No file lines were removed."),
      removed,
    };
  }
}
