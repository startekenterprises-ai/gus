/**
 * The Gmail pack (Phase 6) — GUS's first capability pack.
 *
 * Gmail only; Calendar is a separate later pack. The pack executes in
 * the CONTROL PLANE, exactly like `fetch` executes in the egress
 * proxy: the Google OAuth credential lives in the Vault Broker under
 * the name "gmail-oauth" and is used only inside withSecret callbacks
 * in this process. It never enters the agent's context, never crosses
 * the comm bridge, and is revocable two ways — remove the vault
 * secret (`vault-admin remove gmail-oauth` / `gmail-admin revoke`),
 * or revoke GUS's access on the Google account's permissions page.
 *
 * The permission model lives in policy.ts (Once / Always / Never,
 * with the Yue hard lines in code); this file is the execution side:
 *
 *   - Inbound mail is Agent-Shield-scanned (the Phase 4 gate, surface
 *     "tool-result") BEFORE any of its text can reach the model. A
 *     blocked message is withheld — the model hears that it was
 *     withheld and why, never the content.
 *   - Outbound mail (draft / send / reply) passes the secret-guard
 *     (S1 patterns via screenText) AND the vault's value check
 *     (findValuesIn) before anything leaves. A hit refuses the whole
 *     action loudly — classes and secret NAMES only, never values.
 *   - Every action verifies its post-condition against the mailbox
 *     (the sent message exists in the right thread, the labels
 *     actually changed, the deleted message is actually gone) and
 *     ends verified-done or failed-loudly. Nothing reports success on
 *     the transport's say-so alone, and nothing fails silently.
 *
 * Transports: HttpGmailTransport is the live Gmail API v1 client
 * (refresh-token exchange against the vault-held OAuth client). The
 * MockGmailTransport is the in-memory mailbox the unit tests and the
 * OMEN drill run against — same interface, same service code path.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { screenText, type ToolClass } from "@gus/shared";
import type { VaultBroker } from "@gus/vault";

// ------------------------------------------------------------------ types

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  /** Bare lowercased address of the sender. */
  from: string;
  /** Bare lowercased recipient addresses. */
  to: string[];
  subject: string;
  snippet: string;
  /** RFC 2822 date header, as received. */
  date: string;
  labelIds: string[];
}

export interface GmailMessage extends GmailMessageSummary {
  body: string;
}

export interface GmailOutgoing {
  to: string[];
  subject: string;
  body: string;
  /** Set for replies: the Gmail thread the message joins. */
  threadId?: string;
}

/** The mailbox operations the pack needs. Implemented by the live API
 *  client and by the in-memory mock; the service cannot tell them
 *  apart, which is what makes the mock a faithful drill vehicle. */
export interface GmailTransport {
  search(query: string, maxResults: number): Promise<GmailMessageSummary[]>;
  get(id: string): Promise<GmailMessage | null>;
  createDraft(msg: GmailOutgoing): Promise<{ draftId: string; messageId: string }>;
  send(msg: GmailOutgoing): Promise<{ messageId: string; threadId: string }>;
  modify(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void>;
  trash(id: string): Promise<void>;
  deleteForever(id: string): Promise<void>;
  createBlockFilter(fromAddress: string): Promise<{ filterId: string }>;
}

export const GMAIL_OAUTH_SECRET = "gmail-oauth";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ------------------------------------------------------------- tool shape

export const GMAIL_TOOL_CLASSES: Record<string, ToolClass> = {
  gmail_search: "read",
  gmail_read: "read",
  gmail_summarize: "read",
  gmail_draft: "write",
  gmail_label: "write",
  gmail_archive: "write",
  gmail_spam: "write",
  gmail_block_sender: "write",
  gmail_delete: "destructive",
  gmail_send: "external-send",
  gmail_reply: "external-send",
};

export function isGmailTool(tool: string): boolean {
  return tool in GMAIL_TOOL_CLASSES;
}

/** The permission-model action class a gmail tool belongs to. */
export function gmailActionClass(tool: string): string {
  switch (tool) {
    case "gmail_send":
      return "gmail-send";
    case "gmail_reply":
      return "gmail-reply";
    case "gmail_label":
    case "gmail_archive":
    case "gmail_spam":
      return "gmail-modify";
    case "gmail_delete":
      return "gmail-delete";
    default:
      return `gmail-${tool.replace(/^gmail_/, "")}`;
  }
}

/** "Name <a@b.c>" or a bare address → the bare lowercased address. */
export function bareAddress(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim().toLowerCase();
}

export function normalizeAddress(addr: string): string {
  return bareAddress(addr);
}

/** Recipients a gmail call names: `to` (string or list). Replies may
 *  omit it — the service then defaults to the original sender, and the
 *  classifier treats an unstated-recipient reply accordingly. */
export function gmailRecipients(args: Record<string, unknown>): string[] {
  const raw = args.to;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  return list.map(normalizeAddress).filter((a) => a.includes("@"));
}

/** The exact message IDs a gmail call names: `messageIds` (list) or
 *  `messageId` (single). Bulk and delete approvals enumerate these. */
export function gmailMessageIds(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.messageIds)) return args.messageIds.map(String);
  if (typeof args.messageId === "string" && args.messageId) return [args.messageId];
  return [];
}

// --------------------------------------------------------- directory store

interface DirectoryData {
  /** Addresses GUS has corresponded with — seen in fetched mail or
   *  sent to successfully. The classifier's "known recipient" set:
   *  a send/reply to anyone NOT in here is a first-time external
   *  send and always prompts (policy.ts). */
  known: string[];
  /** Senders the operator had GUS block. */
  blocked: string[];
}

/**
 * The pack's learned directory: a control-plane state file
 * (<state>/gmail-directory.json), written only by this process. It is
 * deliberately NOT part of policy.json — policy is what the operator
 * decrees; this is what the mailbox has shown. The classifier reads
 * the same file (PolicyStore takes its path) so classification and
 * execution always agree on who is "known".
 */
export class GmailDirectory {
  constructor(private path: string) {}

  load(): DirectoryData {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<DirectoryData>;
        return {
          known: Array.isArray(raw.known) ? raw.known.map((a) => normalizeAddress(String(a))) : [],
          blocked: Array.isArray(raw.blocked) ? raw.blocked.map((a) => normalizeAddress(String(a))) : [],
        };
      }
    } catch {
      /* malformed learned state: start empty — every recipient is
         first-time, which fails toward prompting, never toward sending */
    }
    return { known: [], blocked: [] };
  }

  private save(data: DirectoryData): void {
    writeFileSync(this.path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  isKnown(address: string): boolean {
    return this.load().known.includes(normalizeAddress(address));
  }

  isBlocked(address: string): boolean {
    return this.load().blocked.includes(normalizeAddress(address));
  }

  recordKnown(addresses: string[]): void {
    const data = this.load();
    const set = new Set(data.known);
    let changed = false;
    for (const a of addresses) {
      const n = normalizeAddress(a);
      if (n.includes("@") && !set.has(n)) {
        set.add(n);
        changed = true;
      }
    }
    if (changed) this.save({ known: [...set].sort(), blocked: data.blocked });
  }

  recordBlocked(address: string): void {
    const data = this.load();
    const n = normalizeAddress(address);
    if (!data.blocked.includes(n)) this.save({ known: data.known, blocked: [...data.blocked, n].sort() });
  }
}

// ------------------------------------------------------------ mock transport

interface MockRecord extends GmailMessage {
  draft?: boolean;
}

/**
 * In-memory mailbox for tests and the container drill. Faithful to
 * the interface's semantics: sends land in the mailbox (SENT), drafts
 * exist as messages (DRAFT), trash/delete actually remove or relabel,
 * and every mutating call is logged so tests can prove what did NOT
 * happen (a refused send leaves `sent` empty).
 */
export class MockGmailTransport implements GmailTransport {
  private messages = new Map<string, MockRecord>();
  private counter = 0;
  readonly sent: GmailOutgoing[] = [];
  readonly filters: string[] = [];

  constructor(seed: GmailMessage[] = []) {
    for (const m of seed) this.messages.set(m.id, { ...m });
  }

  private nextId(prefix: string): string {
    return `${prefix}_${++this.counter}`;
  }

  async search(query: string, maxResults: number): Promise<GmailMessageSummary[]> {
    const q = query.toLowerCase();
    const hits = [...this.messages.values()].filter(
      (m) =>
        !q ||
        m.subject.toLowerCase().includes(q) ||
        m.from.includes(q) ||
        m.snippet.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q),
    );
    return hits.slice(0, maxResults).map(({ body: _body, draft: _draft, ...summary }) => summary);
  }

  async get(id: string): Promise<GmailMessage | null> {
    const m = this.messages.get(id);
    if (!m) return null;
    const { draft: _draft, ...msg } = m;
    return { ...msg };
  }

  async createDraft(msg: GmailOutgoing): Promise<{ draftId: string; messageId: string }> {
    const messageId = this.nextId("mockmsg");
    this.messages.set(messageId, {
      id: messageId,
      threadId: msg.threadId ?? this.nextId("mockthread"),
      from: "me",
      to: msg.to,
      subject: msg.subject,
      snippet: msg.body.slice(0, 80),
      date: new Date().toUTCString(),
      labelIds: ["DRAFT"],
      body: msg.body,
      draft: true,
    });
    return { draftId: this.nextId("mockdraft"), messageId };
  }

  async send(msg: GmailOutgoing): Promise<{ messageId: string; threadId: string }> {
    this.sent.push(msg);
    const messageId = this.nextId("mockmsg");
    const threadId = msg.threadId ?? this.nextId("mockthread");
    this.messages.set(messageId, {
      id: messageId,
      threadId,
      from: "me",
      to: msg.to,
      subject: msg.subject,
      snippet: msg.body.slice(0, 80),
      date: new Date().toUTCString(),
      labelIds: ["SENT"],
      body: msg.body,
    });
    return { messageId, threadId };
  }

  async modify(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    const m = this.messages.get(id);
    if (!m) throw new Error(`no message ${id}`);
    const set = new Set(m.labelIds);
    for (const l of addLabelIds) set.add(l);
    for (const l of removeLabelIds) set.delete(l);
    m.labelIds = [...set];
  }

  async trash(id: string): Promise<void> {
    const m = this.messages.get(id);
    if (!m) throw new Error(`no message ${id}`);
    await this.modify(id, ["TRASH"], ["INBOX"]);
  }

  async deleteForever(id: string): Promise<void> {
    if (!this.messages.delete(id)) throw new Error(`no message ${id}`);
  }

  async createBlockFilter(fromAddress: string): Promise<{ filterId: string }> {
    this.filters.push(normalizeAddress(fromAddress));
    return { filterId: this.nextId("mockfilter") };
  }
}

// ------------------------------------------------------------ live transport

export type GmailHttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

const defaultHttpFetch: GmailHttpFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, json: async () => res.json().catch(() => null) };
};

interface OAuthMaterial {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

function base64UrlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function buildMime(msg: GmailOutgoing): string {
  const headers = [
    `To: ${msg.to.join(", ")}`,
    `Subject: ${msg.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + msg.body;
}

interface ApiPayload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: ApiPayload[];
}

interface ApiMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: ApiPayload;
}

function headerOf(payload: ApiPayload | undefined, name: string): string {
  const h = payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function extractBody(payload: ApiPayload | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return base64UrlDecode(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const text = extractBody(part);
    if (text) return text;
  }
  if (payload.body?.data && (payload.mimeType ?? "text/plain").startsWith("text/")) {
    return base64UrlDecode(payload.body.data);
  }
  return "";
}

function toMessage(m: ApiMessage): GmailMessage {
  const fromHeader = headerOf(m.payload, "from");
  const toHeader = headerOf(m.payload, "to");
  return {
    id: m.id,
    threadId: m.threadId,
    from: bareAddress(fromHeader),
    to: toHeader
      ? toHeader.split(",").map((a) => bareAddress(a)).filter((a) => a.includes("@"))
      : [],
    subject: headerOf(m.payload, "subject"),
    snippet: m.snippet ?? "",
    date: headerOf(m.payload, "date"),
    labelIds: m.labelIds ?? [],
    body: extractBody(m.payload),
  };
}

/**
 * The live Gmail API v1 client. The vault secret "gmail-oauth" holds
 * a JSON object { client_id, client_secret, refresh_token } — the
 * operator creates it once (docs/gmail-pack.md). Access tokens are
 * minted from the refresh token inside withSecret callbacks and
 * cached in this process's memory only, until they expire.
 */
export class HttpGmailTransport implements GmailTransport {
  private tokenCache?: { token: string; expiresAt: number };

  constructor(
    private vault: VaultBroker,
    private http: GmailHttpFetch = defaultHttpFetch,
  ) {}

  private oauthMaterial(): OAuthMaterial {
    if (!this.vault.has(GMAIL_OAUTH_SECRET)) {
      throw new Error(
        `no vault secret named "${GMAIL_OAUTH_SECRET}" — the Gmail pack is not set up yet (see docs/gmail-pack.md)`,
      );
    }
    const material = this.vault.withSecret(GMAIL_OAUTH_SECRET, (v) => {
      const parsed = JSON.parse(v) as Partial<OAuthMaterial>;
      if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
        throw new Error(
          `vault secret "${GMAIL_OAUTH_SECRET}" is not the expected JSON {client_id, client_secret, refresh_token}`,
        );
      }
      return {
        client_id: parsed.client_id,
        client_secret: parsed.client_secret,
        refresh_token: parsed.refresh_token,
      };
    });
    if (!material) throw new Error(`vault secret "${GMAIL_OAUTH_SECRET}" vanished mid-call`);
    return material;
  }

  private async accessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.tokenCache.token;
    }
    const m = this.oauthMaterial();
    const res = await this.http(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: m.client_id,
        client_secret: m.client_secret,
        refresh_token: m.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (res.status !== 200) {
      throw new Error(
        `Google refused the OAuth token exchange (HTTP ${res.status}) — the refresh token may be revoked; see docs/gmail-pack.md`,
      );
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number } | null;
    if (!body?.access_token) throw new Error("Google's token exchange returned no access token");
    this.tokenCache = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  private async api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await this.http(`${GMAIL_API_BASE}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) throw new Error(`Gmail API: not found (${path})`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Gmail API refused ${method} ${path} (HTTP ${res.status})`);
    }
    return (await res.json().catch(() => null)) as T;
  }

  async search(query: string, maxResults: number): Promise<GmailMessageSummary[]> {
    const list = await this.api<{ messages?: { id: string }[] }>(
      `messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    );
    const out: GmailMessageSummary[] = [];
    for (const ref of list.messages ?? []) {
      const m = await this.api<ApiMessage>(`messages/${ref.id}?format=metadata`);
      const { body: _body, ...summary } = toMessage(m);
      out.push(summary);
    }
    return out;
  }

  async get(id: string): Promise<GmailMessage | null> {
    try {
      const m = await this.api<ApiMessage>(`messages/${id}?format=full`);
      return toMessage(m);
    } catch (e) {
      if (e instanceof Error && e.message.includes("not found")) return null;
      throw e;
    }
  }

  async createDraft(msg: GmailOutgoing): Promise<{ draftId: string; messageId: string }> {
    const d = await this.api<{ id: string; message: { id: string } }>("drafts", "POST", {
      message: { raw: base64UrlEncode(buildMime(msg)), threadId: msg.threadId },
    });
    return { draftId: d.id, messageId: d.message.id };
  }

  async send(msg: GmailOutgoing): Promise<{ messageId: string; threadId: string }> {
    const m = await this.api<{ id: string; threadId: string }>("messages/send", "POST", {
      raw: base64UrlEncode(buildMime(msg)),
      threadId: msg.threadId,
    });
    return { messageId: m.id, threadId: m.threadId };
  }

  async modify(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    await this.api(`messages/${id}/modify`, "POST", { addLabelIds, removeLabelIds });
  }

  async trash(id: string): Promise<void> {
    await this.api(`messages/${id}/trash`, "POST", {});
  }

  async deleteForever(id: string): Promise<void> {
    await this.api(`messages/${id}`, "DELETE");
  }

  async createBlockFilter(fromAddress: string): Promise<{ filterId: string }> {
    const f = await this.api<{ id: string }>("settings/filters", "POST", {
      criteria: { from: normalizeAddress(fromAddress) },
      action: { removeLabelIds: ["INBOX"], addLabelIds: ["SPAM"] },
    });
    return { filterId: f.id };
  }
}

// ------------------------------------------------------------------ service

/** The slice of the Phase 4 Shield gate the pack depends on —
 *  ShieldGate satisfies it structurally. */
export interface GmailShieldScanner {
  scanSurface(
    surface: "tool-result",
    jobId: string,
    content: string,
  ): Promise<{ action: "allow" | "flag" | "block"; scanned: boolean; detail: string }>;
}

export interface GmailOutcome {
  ok: boolean;
  summary: string;
  /**
   * True for hard refusals and execution failures (secret-guard hit,
   * transport error, unverifiable outcome): the CommServer settles
   * the job failed-loudly, like an egress refusal. Absent/false for
   * outcomes the model may simply hear — above all a Shield-withheld
   * read, which mirrors a blocked fetch result: the job continues,
   * the content never crossed.
   */
  refused?: boolean;
}

const MAX_BODY_CHARS = 12_000;

/**
 * Executes gmail_* tools in the control plane. Called by the
 * CommServer only AFTER the classifier allowed the call (or consumed
 * a one-time approval bound to these exact arguments) — the service
 * itself never decides permissions; it enforces the content rules
 * (Shield in, secret-guard out) and verifies outcomes.
 */
export class GmailService {
  constructor(
    private transport: GmailTransport,
    private opts: {
      directory: GmailDirectory;
      shield?: GmailShieldScanner;
      vault?: VaultBroker;
    },
  ) {}

  async execute(jobId: string, tool: string, args: Record<string, unknown>): Promise<GmailOutcome> {
    try {
      switch (tool) {
        case "gmail_search":
          return await this.search(jobId, args);
        case "gmail_read":
        case "gmail_summarize":
          return await this.read(jobId, tool, args);
        case "gmail_draft":
          return await this.draft(args);
        case "gmail_send":
          return await this.send(args);
        case "gmail_reply":
          return await this.reply(args);
        case "gmail_label":
        case "gmail_archive":
        case "gmail_spam":
          return await this.modify(tool, args);
        case "gmail_delete":
          return await this.deleteMessages(args);
        case "gmail_block_sender":
          return await this.blockSender(args);
        default:
          return { ok: false, refused: true, summary: `unknown gmail tool "${tool}" — nothing executed` };
      }
    } catch (e) {
      const detail = screenText(e instanceof Error ? e.message : String(e)).redacted;
      return { ok: false, refused: true, summary: `${tool} failed loudly: ${detail}` };
    }
  }

  // ---------------------------------------------------------- inbound

  /** Scan one piece of inbound content. Returns the text the model
   *  may see, or null when the gate blocks it (withheld). Flagged or
   *  unscanned content is annotated, never silently trusted. */
  private async scanInbound(
    jobId: string,
    content: string,
  ): Promise<{ text: string; note?: string } | null> {
    if (!this.opts.shield) {
      return { text: content, note: "the Shield gate is not wired into the Gmail pack — content unscanned" };
    }
    const d = await this.opts.shield.scanSurface("tool-result", jobId, content);
    if (d.action === "block") return null;
    if (d.action === "flag") return { text: content, note: `shield note: ${d.detail}` };
    if (!d.scanned) return { text: content, note: d.detail };
    return { text: content };
  }

  private async search(jobId: string, args: Record<string, unknown>): Promise<GmailOutcome> {
    const query = String(args.query ?? "");
    const max = Math.min(25, Math.max(1, Number(args.maxResults ?? 10) || 10));
    const results = await this.transport.search(query, max);
    // Everything the mailbox shows us teaches the directory: senders
    // and participants of real mail are known correspondents now.
    for (const m of results) this.opts.directory.recordKnown([m.from, ...m.to]);
    const lines: string[] = [];
    let withheld = 0;
    for (const m of results) {
      const scanned = await this.scanInbound(
        jobId,
        `From: ${m.from}\nSubject: ${m.subject}\n${m.snippet}`,
      );
      if (!scanned) {
        withheld++;
        continue;
      }
      lines.push(
        `id=${m.id} thread=${m.threadId} from=${m.from} date=${m.date} subject=${JSON.stringify(m.subject)} ` +
          `labels=[${m.labelIds.join(",")}] snippet=${JSON.stringify(m.snippet)}` +
          (scanned.note ? ` (${scanned.note})` : ""),
      );
    }
    const head = `gmail_search ${JSON.stringify(query)}: ${lines.length} message(s) shown`;
    const tail =
      withheld > 0
        ? `; ${withheld} message(s) withheld by the Agent-Shield gate (their content was not shown)`
        : "";
    return { ok: true, summary: head + tail + (lines.length ? `\n${lines.join("\n")}` : "") };
  }

  private async read(jobId: string, tool: string, args: Record<string, unknown>): Promise<GmailOutcome> {
    const id = String(args.messageId ?? "");
    if (!id) return { ok: false, refused: true, summary: `${tool} failed loudly: no messageId named` };
    const msg = await this.transport.get(id);
    if (!msg) return { ok: false, refused: true, summary: `${tool} failed loudly: no message with id ${id}` };
    this.opts.directory.recordKnown([msg.from, ...msg.to]);
    const scanned = await this.scanInbound(jobId, `Subject: ${msg.subject}\n\n${msg.body}`);
    if (!scanned) {
      return {
        ok: false,
        summary:
          `the content of message ${id} was withheld by the Agent-Shield gate — ` +
          `nothing from it was shown to the agent. (From ${msg.from}, subject ${JSON.stringify(msg.subject)}.)`,
      };
    }
    const body =
      scanned.text.length > MAX_BODY_CHARS
        ? scanned.text.slice(0, MAX_BODY_CHARS) + `\n[body truncated at ${MAX_BODY_CHARS} chars]`
        : scanned.text;
    return {
      ok: true,
      summary:
        `message ${id} thread=${msg.threadId} from=${msg.from} to=${msg.to.join(", ")} ` +
        `date=${msg.date} labels=[${msg.labelIds.join(",")}]` +
        (scanned.note ? ` (${scanned.note})` : "") +
        `\n${body}`,
    };
  }

  // ---------------------------------------------------------- outbound

  /** The outbound secret-guard. Returns a refusal summary, or null
   *  when the content may leave. Pattern classes and vault secret
   *  NAMES only — a value never appears in the refusal. */
  private guardOutbound(subject: string, body: string): string | null {
    const combined = `${subject}\n${body}`;
    const screened = screenText(combined);
    if (!screened.clean) {
      const classes = [...new Set(screened.findings.map((f) => f.patternClass))].join(", ");
      return `refused by the secret-guard: the outgoing mail matches secret pattern(s) [${classes}] — nothing was sent`;
    }
    if (this.opts.vault) {
      const names = this.opts.vault.findValuesIn(combined);
      if (names.length > 0) {
        return `refused by the secret-guard: the outgoing mail contains the stored vault secret(s) named [${names.join(", ")}] — nothing was sent`;
      }
    }
    return null;
  }

  private outgoingFrom(args: Record<string, unknown>): GmailOutgoing | string {
    const to = gmailRecipients(args);
    if (to.length === 0) return "no recipients named (arg `to`)";
    return {
      to,
      subject: String(args.subject ?? ""),
      body: String(args.body ?? ""),
      threadId: typeof args.threadId === "string" ? args.threadId : undefined,
    };
  }

  private async draft(args: Record<string, unknown>): Promise<GmailOutcome> {
    const out = this.outgoingFrom(args);
    if (typeof out === "string") return { ok: false, refused: true, summary: `gmail_draft failed loudly: ${out}` };
    const refusal = this.guardOutbound(out.subject, out.body);
    if (refusal) return { ok: false, refused: true, summary: `gmail_draft ${refusal.replace("nothing was sent", "no draft was created")}` };
    const { draftId, messageId } = await this.transport.createDraft(out);
    const check = await this.transport.get(messageId);
    if (!check || check.subject !== out.subject) {
      return { ok: false, refused: true, summary: `gmail_draft failed loudly: the created draft could not be verified in the mailbox` };
    }
    return {
      ok: true,
      summary: `draft created and verified (draft ${draftId}, message ${messageId}) to ${out.to.join(", ")} subject ${JSON.stringify(out.subject)} — not sent`,
    };
  }

  private async send(args: Record<string, unknown>): Promise<GmailOutcome> {
    const out = this.outgoingFrom(args);
    if (typeof out === "string") return { ok: false, refused: true, summary: `gmail_send failed loudly: ${out}` };
    const refusal = this.guardOutbound(out.subject, out.body);
    if (refusal) return { ok: false, refused: true, summary: `gmail_send ${refusal}` };
    const { messageId, threadId } = await this.transport.send(out);
    const check = await this.transport.get(messageId);
    if (!check) {
      return { ok: false, refused: true, summary: `gmail_send failed loudly: the send was not verifiable — no message ${messageId} in the mailbox` };
    }
    this.opts.directory.recordKnown(out.to);
    return {
      ok: true,
      summary: `sent and verified (message ${messageId}, thread ${threadId}) to ${out.to.join(", ")} subject ${JSON.stringify(out.subject)}`,
    };
  }

  private async reply(args: Record<string, unknown>): Promise<GmailOutcome> {
    const originalId = String(args.messageId ?? "");
    if (!originalId) return { ok: false, refused: true, summary: "gmail_reply failed loudly: no messageId named" };
    const original = await this.transport.get(originalId);
    if (!original) return { ok: false, refused: true, summary: `gmail_reply failed loudly: no message with id ${originalId}` };
    const to = gmailRecipients(args);
    const out: GmailOutgoing = {
      to: to.length > 0 ? to : [original.from],
      subject:
        typeof args.subject === "string" && args.subject
          ? args.subject
          : original.subject.toLowerCase().startsWith("re:")
            ? original.subject
            : `Re: ${original.subject}`,
      body: String(args.body ?? ""),
      threadId: original.threadId,
    };
    const refusal = this.guardOutbound(out.subject, out.body);
    if (refusal) return { ok: false, refused: true, summary: `gmail_reply ${refusal}` };
    const { messageId, threadId } = await this.transport.send(out);
    const check = await this.transport.get(messageId);
    if (!check || check.threadId !== original.threadId) {
      return {
        ok: false,
        refused: true,
        summary: `gmail_reply failed loudly: the reply was not verifiable in thread ${original.threadId}`,
      };
    }
    this.opts.directory.recordKnown(out.to);
    return {
      ok: true,
      summary: `reply sent and verified in thread ${threadId} (message ${messageId}) to ${out.to.join(", ")} subject ${JSON.stringify(out.subject)}`,
    };
  }

  // ---------------------------------------------------------- mailbox ops

  private async modify(tool: string, args: Record<string, unknown>): Promise<GmailOutcome> {
    const ids = gmailMessageIds(args);
    if (ids.length === 0) return { ok: false, refused: true, summary: `${tool} failed loudly: no message IDs named` };
    let add: string[] = [];
    let remove: string[] = [];
    if (tool === "gmail_archive") {
      remove = ["INBOX"];
    } else if (tool === "gmail_spam") {
      add = ["SPAM"];
      remove = ["INBOX"];
    } else {
      add = [
        ...(Array.isArray(args.addLabelIds) ? args.addLabelIds.map(String) : []),
        ...(typeof args.label === "string" && args.label ? [args.label] : []),
      ];
      remove = Array.isArray(args.removeLabelIds) ? args.removeLabelIds.map(String) : [];
      if (add.length === 0 && remove.length === 0) {
        return { ok: false, refused: true, summary: "gmail_label failed loudly: no label changes named (label / addLabelIds / removeLabelIds)" };
      }
    }
    for (const id of ids) await this.transport.modify(id, add, remove);
    // Verify against the first message: the labels must have moved.
    const check = await this.transport.get(ids[0]);
    if (!check) return { ok: false, refused: true, summary: `${tool} failed loudly: message ${ids[0]} vanished during the change` };
    for (const l of add) {
      if (!check.labelIds.includes(l)) {
        return { ok: false, refused: true, summary: `${tool} failed loudly: label ${l} not present on ${ids[0]} after the change` };
      }
    }
    for (const l of remove) {
      if (check.labelIds.includes(l)) {
        return { ok: false, refused: true, summary: `${tool} failed loudly: label ${l} still present on ${ids[0]} after the change` };
      }
    }
    return {
      ok: true,
      summary: `${tool} applied and verified on ${ids.length} message(s) [${ids.join(", ")}]: +[${add.join(",")}] -[${remove.join(",")}]`,
    };
  }

  private async deleteMessages(args: Record<string, unknown>): Promise<GmailOutcome> {
    const ids = gmailMessageIds(args);
    if (ids.length === 0) return { ok: false, refused: true, summary: "gmail_delete failed loudly: no message IDs named" };
    const permanent = args.permanent === true;
    for (const id of ids) {
      if (permanent) await this.transport.deleteForever(id);
      else await this.transport.trash(id);
    }
    for (const id of ids) {
      const check = await this.transport.get(id);
      if (permanent && check) {
        return { ok: false, refused: true, summary: `gmail_delete failed loudly: message ${id} is still in the mailbox after permanent delete` };
      }
      if (!permanent && (!check || !check.labelIds.includes("TRASH"))) {
        return { ok: false, refused: true, summary: `gmail_delete failed loudly: message ${id} is not in TRASH after the delete` };
      }
    }
    return {
      ok: true,
      summary: `deleted and verified ${ids.length} message(s) [${ids.join(", ")}] (${permanent ? "permanent" : "moved to trash"})`,
    };
  }

  private async blockSender(args: Record<string, unknown>): Promise<GmailOutcome> {
    const raw = typeof args.from === "string" ? args.from : typeof args.address === "string" ? args.address : "";
    const address = normalizeAddress(raw);
    if (!address.includes("@")) {
      return { ok: false, refused: true, summary: "gmail_block_sender failed loudly: no sender address named (arg `from`)" };
    }
    const { filterId } = await this.transport.createBlockFilter(address);
    this.opts.directory.recordBlocked(address);
    return {
      ok: true,
      summary: `sender ${address} blocked (filter ${filterId}): their future mail skips the inbox and lands in spam`,
    };
  }
}

// ---------------------------------------------------------------- gmail-admin

/**
 * Operator CLI (`node main.js gmail-admin <status|revoke>`) — the
 * pack's setup/revoke surface. `status` prints setup state and counts
 * only, never a credential value. `revoke` removes the vault secret:
 * the pack is dead from that moment, one click, no Google round-trip
 * needed (revoking on Google's side too is in docs/gmail-pack.md).
 */
export function runGmailAdmin(argv: string[], vault: VaultBroker, directory: GmailDirectory): number {
  const [cmd] = argv;
  try {
    switch (cmd) {
      case "status": {
        const data = directory.load();
        console.log(`gmail pack: ${vault.has(GMAIL_OAUTH_SECRET) ? "configured (OAuth credential in the vault)" : "NOT configured — no gmail-oauth secret in the vault"}`);
        console.log(`known correspondents: ${data.known.length}; blocked senders: ${data.blocked.length}`);
        return 0;
      }
      case "revoke": {
        console.log(
          vault.remove(GMAIL_OAUTH_SECRET)
            ? "gmail pack revoked: the OAuth credential is removed from the vault — the pack can no longer touch the mailbox"
            : "gmail pack: no OAuth credential was in the vault",
        );
        return 0;
      }
      default:
        console.error("usage: gmail-admin <status|revoke>");
        return 2;
    }
  } catch (e) {
    console.error(`gmail-admin: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
