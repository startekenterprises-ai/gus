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
import { HELP_HTML } from "./help.js";

const MAX_BODY_BYTES = 64 * 1024;

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
    if (method === "GET" && path === "/api/status") return json(200, this.backend.status());
    if (method === "GET" && path === "/api/ledger") return json(200, this.backend.ledger());
    if (method === "GET" && path === "/api/jobs") return json(200, this.backend.jobs());
    if (method === "GET" && path === "/api/approvals") return json(200, this.backend.approvals());
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
