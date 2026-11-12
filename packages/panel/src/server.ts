/**
 * Panel HTTP server (foundation spec §2.1: a control-plane surface,
 * not a channel) — Phase 4.
 *
 * Posture:
 *   - Binds where the operator says (default 127.0.0.1 — the operator's
 *     own machine or an SSH tunnel; putting it on a wider interface is
 *     an explicit operator choice via GUS_PANEL_HOST).
 *   - Every route requires the operator token: a 0600 file in
 *     control-plane state, minted at first boot. Accepted as an
 *     Authorization: Bearer header, the gus_panel cookie (set when a
 *     valid ?t= link is opened), or ?t= itself. Compared in constant
 *     time. There is no other credential and no session store.
 *   - It can only do what the PanelBackend can do — and the backend
 *     delegates to the same engines the channel uses. A compromised
 *     panel token is therefore exactly as powerful as the operator's
 *     Telegram, no more: it cannot read a secret, forge an approval,
 *     or raise a cap past the Governor — those paths do not exist.
 *   - A listen failure (port in use after an update restart) is
 *     reported via onError and never crashes the control plane.
 */
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { PanelBackend } from "./types.js";
import { PANEL_HTML } from "./page.js";
import { HELP_ENTRIES, HELP_HTML } from "./help.js";

const MAX_BODY_BYTES = 64 * 1024;
/** v0.9: the voice call's raw-audio body cap. A push-to-talk
 *  utterance is seconds of speech (~32 KB/s as WAV); 16 MB is
 *  minutes of headroom, and the voice service enforces the same
 *  cap again on its side of the contract. */
const MAX_AUDIO_BODY_BYTES = 16 * 1024 * 1024;

export class PanelServer {
  private server?: Server;
  private boundPort?: number;

  constructor(
    private backend: PanelBackend,
    private opts: {
      token: string;
      host?: string;
      port?: number;
      onError?: (e: Error) => void;
    },
  ) {}

  /** The port actually bound (opts.port may be 0 in tests). */
  get port(): number | undefined {
    return this.boundPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, detail: `panel error: ${e instanceof Error ? e.message : String(e)}` }));
        } catch { /* socket already gone */ }
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.once("error", (e) => {
        this.opts.onError?.(e);
        resolve();
      });
      server.listen(this.opts.port ?? 8731, this.opts.host ?? "127.0.0.1", () => {
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : undefined;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ------------------------------------------------------------ auth

  private tokenOk(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.opts.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private authed(req: import("node:http").IncomingMessage, url: URL): boolean {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && this.tokenOk(auth.slice("Bearer ".length))) return true;
    if (this.tokenOk(url.searchParams.get("t") ?? undefined)) return true;
    const cookie = req.headers.cookie ?? "";
    const m = cookie.match(/(?:^|;\s*)gus_panel=([^;]+)/);
    if (m && this.tokenOk(decodeURIComponent(m[1]))) return true;
    return false;
  }

  // ------------------------------------------------------------ io

  private async readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return {};
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("request body must be a JSON object");
    return parsed as Record<string, unknown>;
  }

  /** v0.9: the call route's raw body — recorded audio, not JSON.
   *  The content type rides the request header and passes through
   *  to the transcription service untouched. */
  private async readRaw(
    req: import("node:http").IncomingMessage,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://panel.local");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (!this.authed(req, url)) {
      json(401, { ok: false, detail: "operator token required (open the panel link from your install, or send Authorization: Bearer <token>)" });
      return;
    }
    // A valid ?t= link plants the cookie so the page's own API calls
    // authenticate without the token riding every URL.
    if (url.searchParams.get("t")) {
      res.setHeader("set-cookie", `gus_panel=${encodeURIComponent(this.opts.token)}; Path=/; HttpOnly; SameSite=Strict`);
    }

    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PANEL_HTML);
      return;
    }
    // v0.5.1: the help/docs page — behind the same auth check as
    // every other route (it runs above, before routing). Anchors
    // match the help registry ids the panel's pop-ups link to.
    if (method === "GET" && path === "/help") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HELP_HTML);
      return;
    }
    // v0.6: the Chat view. History is plain JSON; the frame route
    // below is the panel's one binary response.
    if (method === "GET" && path === "/api/chat/history") return json(200, this.backend.chatHistory());
    if (method === "GET" && path === "/api/watch/timeline") return json(200, this.backend.watchTimeline());
    if (method === "GET" && path === "/api/watch/frame") {
      const frame = await this.backend.watchFrame();
      if (!frame.ok) return json(503, { ok: false, detail: frame.detail });
      res.writeHead(200, {
        "content-type": frame.contentType,
        "cache-control": "no-store",
        "content-length": frame.bytes.length,
      });
      res.end(Buffer.from(frame.bytes));
      return;
    }
    if (method === "POST" && path === "/api/chat") {
      const body = await this.readJson(req);
      const result = await this.backend.submitChat(
        typeof body.text === "string" ? body.text : "",
      );
      return json(result.ok ? 200 : 400, result);
    }

    // v0.9: the voice channel — settings (the operator's local
    // speech services) and the push-to-talk call itself. The call
    // takes the raw recording as its body; the answer is JSON
    // carrying the transcript, the reply text, and the spoken
    // reply as base64. Same operator-token gate as every route.
    if (method === "GET" && path === "/api/voice/settings") {
      return json(200, this.backend.voiceSettings());
    }
    if (method === "POST" && path === "/api/voice/settings") {
      const body = await this.readJson(req);
      const result = await this.backend.setVoiceSettings({
        enabled: body.enabled === true,
        sttBaseUrl: typeof body.sttBaseUrl === "string" ? body.sttBaseUrl : "",
        sttModel: typeof body.sttModel === "string" ? body.sttModel : "",
        ttsBaseUrl: typeof body.ttsBaseUrl === "string" ? body.ttsBaseUrl : "",
        ttsModel: typeof body.ttsModel === "string" ? body.ttsModel : "",
        ttsVoice: typeof body.ttsVoice === "string" ? body.ttsVoice : "",
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/voice/call") {
      const audio = await this.readRaw(req, MAX_AUDIO_BODY_BYTES);
      const result = await this.backend.voiceCall(
        audio,
        req.headers["content-type"] ?? "audio/wav",
      );
      return json(result.ok ? 200 : 400, result);
    }

    // v0.8: the help registry as JSON, for the desktop app's
    // native Settings (per-control help pop-overs + the Help &
    // support section). Same registry object the /help page and
    // the panel's own pop-ups render from — one source of truth,
    // third surface. No backend call: the registry lives in this
    // package.
    if (method === "GET" && path === "/api/help") return json(200, { entries: HELP_ENTRIES });
    // v0.8: the settings detail (Mac jail contents + named
    // delegates) for the desktop Settings window — read-only.
    if (method === "GET" && path === "/api/settings-detail") return json(200, this.backend.settingsDetail());

    if (method === "GET" && path === "/api/status") return json(200, this.backend.status());
    if (method === "GET" && path === "/api/ledger") return json(200, this.backend.ledger());
    if (method === "GET" && path === "/api/jobs") return json(200, this.backend.jobs());
    if (method === "GET" && path === "/api/approvals") return json(200, this.backend.approvals());
    // v0.7: resolution history for the desktop Approvals sidebar —
    // read-only, same token gate as every route above.
    if (method === "GET" && path === "/api/approvals/history") return json(200, this.backend.approvalsHistory());
    if (method === "GET" && path === "/api/vault") return json(200, { names: this.backend.vaultNames() });
    if (method === "GET" && path === "/api/onboarding") return json(200, this.backend.onboarding());
    if (method === "GET" && path === "/api/skills") return json(200, this.backend.skills());

    const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
    if (method === "POST" && approvalMatch) {
      const result = await this.backend.resolveApproval(
        decodeURIComponent(approvalMatch[1]),
        approvalMatch[2] === "approve",
      );
      return json(result.ok ? 200 : 409, result);
    }
    if (method === "POST" && path === "/api/kill") {
      const body = await this.readJson(req);
      const result = await this.backend.setKilled(body.on === true);
      return json(result.ok ? 200 : 409, result);
    }
    if (method === "POST" && path === "/api/governor-mode") {
      const body = await this.readJson(req);
      const result = await this.backend.setGovernorMode(String(body.mode ?? ""));
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/approver-policy") {
      const body = await this.readJson(req);
      const result = await this.backend.setApproverPolicy({
        gusApprovesDelegates: body.gusApprovesDelegates === true,
        gusApprovesOwn: body.gusApprovesOwn === true,
        delegatesMayApprove: body.delegatesMayApprove === true,
        scope: body.scope === "all_except_floors" ? "all_except_floors" : "bounded",
        maxApprovalsPerHour:
          typeof body.maxApprovalsPerHour === "number" ? body.maxApprovalsPerHour : 30,
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/shield-policy") {
      const body = await this.readJson(req);
      const result = await this.backend.setShieldPolicy({
        required: body.required === true,
        onUnavailable: typeof body.onUnavailable === "string" ? body.onUnavailable : "",
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/vault") {
      const body = await this.readJson(req);
      const result = this.backend.storeSecret(String(body.name ?? ""), String(body.value ?? ""));
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/onboarding/shield") {
      const body = await this.readJson(req);
      const result = await this.backend.onboardingShield({
        onUnavailable: typeof body.onUnavailable === "string" ? body.onUnavailable : undefined,
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/onboarding/telegram") {
      const body = await this.readJson(req);
      const result = await this.backend.onboardingTelegram({
        token: typeof body.token === "string" ? body.token : undefined,
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/onboarding/provider") {
      const result = await this.backend.onboardingProvider(await this.readJson(req));
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/onboarding/caps") {
      const result = await this.backend.onboardingCaps(await this.readJson(req));
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/onboarding/first-job") {
      const result = await this.backend.onboardingFirstJob();
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/skills/install") {
      const body = await this.readJson(req);
      const result = await this.backend.installSkill({
        path: typeof body.path === "string" ? body.path : undefined,
      });
      return json(result.ok ? 200 : 400, result);
    }

    json(404, { ok: false, detail: `no such panel route: ${method} ${path}` });
  }
}
