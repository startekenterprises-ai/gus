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
 *     time. There is no session store.
 *   - v0.12.0 adds the ONE other credential, deliberately narrower:
 *     a device's per-device credential (devices.ts in the control
 *     plane — stored hashed, revocable). It authenticates ONLY
 *     the companion's existing surface (status, jobs, approvals +
 *     resolution, kill, Governor mode — DEVICE_SURFACE below) and
 *     nothing else: a device credential asking for anything more
 *     gets a 403, not a wider door.
 *   - v0.13.0 (redo R1): the pairing exchange that used to mint
 *     those credentials is GONE — the redo deletes the QR pairing
 *     flow (spec §7), so no route here is reachable without a
 *     credential. Devices are now credentials of the one GUS
 *     identity (identity.ts), enrolled locally; the registry
 *     surface below is list + revoke only. The operator token
 *     remains the local operator credential, exactly as before —
 *     the installed companion's token path is untouched.
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
import type { PanelBackend, PanelChatImageData, PanelChatSyncMessageData, PanelChatSyncTombstoneData } from "./types.js";
import { PANEL_HTML } from "./page.js";
import { HELP_ENTRIES, HELP_HTML } from "./help.js";

const MAX_BODY_BYTES = 64 * 1024;
/** v0.24.0: the chat route's own body cap — a submission may
 *  carry up to 4 photos as base64 (the adapter caps each at
 *  8M chars), so the JSON body can legitimately reach ~33 MB.
 *  Every other route keeps the 64 KB cap. */
const MAX_CHAT_BODY_BYTES = 36 * 1024 * 1024;
/** v0.9: the voice call's raw-audio body cap. A push-to-talk
 *  utterance is seconds of speech (~32 KB/s as WAV); 16 MB is
 *  minutes of headroom, and the voice service enforces the same
 *  cap again on its side of the contract. */
const MAX_AUDIO_BODY_BYTES = 16 * 1024 * 1024;
/** v0.9.1: one streamed chunk of a live call (~250 ms of PCM16
 *  is 8 KB). 1 MB is minutes of headroom per chunk and still
 *  nothing like a recording — a chunk is a breath, not a file. */
const MAX_SESSION_CHUNK_BYTES = 1024 * 1024;

/** v0.12.0: the companion's existing surface — the ONLY routes a
 *  paired device's credential may reach. This list is the
 *  companion client's own call set (apps/companion's GUSClient:
 *  status, approvals, jobs, approval resolution, kill switch,
 *  Governor mode) and nothing else: pairing widens WHO can
 *  present a credential, never WHAT a phone credential can do.
 *  The Watch rides the same client and the same list. */
function isDeviceSurface(method: string, path: string): boolean {
  if (method === "GET" && (path === "/api/status" || path === "/api/jobs" || path === "/api/approvals")) {
    return true;
  }
  if (method === "POST" && (path === "/api/kill" || path === "/api/governor-mode")) return true;
  if (method === "POST" && /^\/api\/approvals\/[^/]+\/(approve|deny)$/.test(path)) return true;
  return false;
}

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
      /** v0.12.0: device-credential authentication, delegated to
       *  the control plane's device registry (which re-reads its
       *  file per call, so a revocation lands on the very next
       *  request). Absent = no device credentials are honoured. */
      deviceAuth?: (credential: string) => boolean;
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

  /** v0.12.0: is this request carrying a live paired-device
   *  credential? Bearer only (a device credential never rides a
   *  URL or a cookie), and checked only when the operator token
   *  didn't match — the operator's own requests never pay the
   *  registry lookup. */
  private deviceAuthed(req: import("node:http").IncomingMessage): boolean {
    if (!this.opts.deviceAuth) return false;
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return false;
    const candidate = auth.slice("Bearer ".length);
    if (this.tokenOk(candidate)) return false; // the operator token — handled by authed()
    return this.opts.deviceAuth(candidate);
  }

  // ------------------------------------------------------------ io

  private async readJson(
    req: import("node:http").IncomingMessage,
    maxBytes: number = MAX_BODY_BYTES,
  ): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new Error("request body too large");
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

    const path = url.pathname;
    const method = req.method ?? "GET";

    const operatorAuthed = this.authed(req, url);
    if (!operatorAuthed) {
      // v0.12.0: the device tier — a paired device's credential
      // reaches the companion's surface and nothing beyond it.
      if (this.deviceAuthed(req)) {
        if (!isDeviceSurface(method, path)) {
          return json(403, {
            ok: false,
            detail: "That route needs the operator token — a paired device's credential covers status, jobs, approvals, the kill switch, and the Governor mode only.",
          });
        }
      } else {
        json(401, { ok: false, detail: "operator token required (open the panel link from your install, or send Authorization: Bearer <token>)" });
        return;
      }
    }
    // A valid ?t= link plants the cookie so the page's own API calls
    // authenticate without the token riding every URL. Operator
    // token only: the cookie carries the operator token, so it is
    // planted only when the ?t= presented IS that token (a device
    // request must never be handed the operator's cookie).
    if (operatorAuthed && this.tokenOk(url.searchParams.get("t") ?? undefined)) {
      res.setHeader("set-cookie", `gus_panel=${encodeURIComponent(this.opts.token)}; Path=/; HttpOnly; SameSite=Strict`);
    }

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
      const body = await this.readJson(req, MAX_CHAT_BODY_BYTES);
      // v0.24.0: photos ride the submission as {mediaType, data}
      // pairs. Shape and caps are enforced by the chat adapter;
      // here the body field is only passed through when it is an
      // array — anything else is treated as no photos, and the
      // adapter refuses unusable entries with its own detail.
      // v0.26.0: `sync` carries the creating device's sync
      // identity for the message, passed through only when it
      // is a plausible shape — the adapter validates it fully.
      const sync = body.sync as
        | { id?: unknown; deviceId?: unknown; seq?: unknown; prevId?: unknown; ts?: unknown }
        | undefined;
      const identity =
        sync &&
        typeof sync.id === "string" &&
        typeof sync.deviceId === "string" &&
        typeof sync.seq === "number" &&
        (sync.prevId === null || typeof sync.prevId === "string") &&
        typeof sync.ts === "number"
          ? {
              id: sync.id,
              deviceId: sync.deviceId,
              seq: sync.seq,
              prevId: sync.prevId as string | null,
              ts: sync.ts,
            }
          : undefined;
      const result = await this.backend.submitChat(
        typeof body.text === "string" ? body.text : "",
        Array.isArray(body.images) ? body.images : undefined,
        identity,
        // v0.40.0: the phone's persona context for this job —
        // passed through only when it is a string; the chat
        // adapter enforces the cap and refuses over-cap in
        // words. The field is never echoed or stored here.
        typeof body.personaContext === "string" ? body.personaContext : undefined,
      );
      return json(result.ok ? 200 : 400, result);
    }

    // v0.26.0: chat-history sync — one exchange per POST. The
    // caller names the record IDs it holds and may push the
    // records this store lacks; the answer carries the records
    // the caller lacks and the IDs the store still wants. The
    // adapter validates every pushed record fully; the body
    // cap matches the chat route's (records are text, but a
    // catch-up after a long offline stretch is not small).
    if (method === "POST" && path === "/api/chat/sync") {
      const body = await this.readJson(req, MAX_CHAT_BODY_BYTES);
      const result = this.backend.chatSync({
        deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
        haveIds: Array.isArray(body.haveIds)
          ? body.haveIds.filter((id): id is string => typeof id === "string")
          : [],
        messages: Array.isArray(body.messages)
          ? (body.messages as PanelChatSyncMessageData[])
          : undefined,
        tombstones: Array.isArray(body.tombstones)
          ? (body.tombstones as PanelChatSyncTombstoneData[])
          : undefined,
      });
      return json(200, result);
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
        sttEngine: typeof body.sttEngine === "string" ? body.sttEngine : undefined,
        sttBaseUrl: typeof body.sttBaseUrl === "string" ? body.sttBaseUrl : "",
        sttModel: typeof body.sttModel === "string" ? body.sttModel : "",
        ttsEngine: typeof body.ttsEngine === "string" ? body.ttsEngine : undefined,
        ttsBaseUrl: typeof body.ttsBaseUrl === "string" ? body.ttsBaseUrl : "",
        ttsModel: typeof body.ttsModel === "string" ? body.ttsModel : "",
        ttsVoice: typeof body.ttsVoice === "string" ? body.ttsVoice : "",
        bargeIn: typeof body.bargeIn === "boolean" ? body.bargeIn : undefined,
        shieldScan: typeof body.shieldScan === "boolean" ? body.shieldScan : undefined,
      });
      return json(result.ok ? 200 : 400, result);
    }
    // v0.9.9: Test Connection — probe the endpoint the form is
    // showing RIGHT NOW (unsaved values in the body; nothing is
    // read from or written to voice.json). The probe's answer
    // (reachable, latency, model presence) is the result; ok
    // mirrors reachable so the pane can color it honestly.
    if (method === "POST" && path === "/api/voice/test-connection") {
      const body = await this.readJson(req);
      if (!this.backend.voiceTestConnection) {
        return json(501, {
          ok: false,
          reachable: false,
          latencyMs: 0,
          models: [],
          modelPresent: null,
          detail: "Connection testing isn't wired in this deployment. Nothing was tested.",
        });
      }
      const result = await this.backend.voiceTestConnection(
        body.kind === "tts" ? "tts" : "stt",
        typeof body.baseUrl === "string" ? body.baseUrl : "",
        typeof body.model === "string" ? body.model : "",
      );
      return json(200, result);
    }
    // v0.9.9: Test mic and speaker, endpoint half — synthesize
    // one test sentence with the form's current TTS values.
    if (method === "POST" && path === "/api/voice/test-speech") {
      const body = await this.readJson(req);
      if (!this.backend.voiceTestSpeech) {
        return json(501, {
          ok: false,
          detail: "Speaker testing isn't wired in this deployment. Nothing was synthesized.",
        });
      }
      const result = await this.backend.voiceTestSpeech(
        typeof body.baseUrl === "string" ? body.baseUrl : "",
        typeof body.model === "string" ? body.model : "",
        typeof body.voice === "string" ? body.voice : "",
      );
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

    // v0.9.1: the live call — one session, streamed both ways.
    // Audio in is raw PCM16 chunks (the session id rides the
    // query string; the body is the breath, not a document);
    // speech out is fetched segment by segment (one sentence
    // each) by the app's playback queue; state is the poll the
    // in-call UI renders from. Same token gate as every route.
    if (method === "POST" && path === "/api/voice/session/start") {
      // v0.9.6: start resolves the call's speech modes (an
      // endpoint probe), so the backend's answer is async.
      // v0.40.0: the phone's persona context for the call may
      // ride the start body — readJson answers {} for the
      // body-less posts older apps make, so their starts are
      // unchanged. The session holds the context in memory
      // only; this route never echoes or stores it.
      const body = await this.readJson(req);
      const result = await this.backend.voiceSessionStart(
        typeof body.personaContext === "string" ? body.personaContext : undefined,
      );
      return json(result.ok ? 200 : 400, result);
    }
    // v0.40.0: a persona-context update for a live call — the
    // phone posts its newly composed prompt when it changes
    // mid-session (a persona switch, a memory write); the
    // session applies it to subsequent turns only. The body
    // carries the context itself, so it is read and handed on,
    // never logged or stored by this route.
    if (method === "POST" && path === "/api/voice/session/context") {
      const body = await this.readJson(req);
      if (!this.backend.voiceSessionContext) {
        return json(501, {
          ok: false,
          detail: "Persona context isn't wired in this deployment. The call keeps the context it already had.",
        });
      }
      const result = this.backend.voiceSessionContext(
        typeof body.sessionId === "string" ? body.sessionId : "",
        typeof body.personaContext === "string" ? body.personaContext : undefined,
      );
      return json(result.ok ? 200 : 409, result);
    }
    // v0.9.6: a final transcript from the app's built-in
    // recognizer (JSON — the words are the body). Same token
    // gate; the session service decides whether the call's
    // resolved mode accepts it.
    // v0.36.0: an in-call camera photo rides the same post —
    // `images` as {mediaType, data} pairs, passed through
    // when it is an array (the session service shape-checks
    // and caps them, and refuses an unusable photo outright);
    // the body cap matches the chat route's, since a photo
    // body is a photo body whichever door it knocks on.
    if (method === "POST" && path === "/api/voice/session/transcript") {
      const body = await this.readJson(req, MAX_CHAT_BODY_BYTES);
      const result = this.backend.voiceSessionTranscript(
        typeof body.sessionId === "string" ? body.sessionId : "",
        typeof body.text === "string" ? body.text : "",
        Array.isArray(body.images)
          ? (body.images as PanelChatImageData[])
          : undefined,
      );
      return json(result.ok ? 200 : 409, result);
    }
    // v0.37.0: Watch mode — the app's per-call camera toggle.
    // Turning it off drops the session's held frames in the
    // core; the toggle itself carries no image data, just the
    // fact and the camera names. Same token gate as every
    // voice route.
    if (method === "POST" && path === "/api/voice/session/watch") {
      const body = await this.readJson(req);
      if (!this.backend.voiceSessionWatch) {
        return json(501, {
          ok: false,
          detail: "Watch mode isn't wired in this deployment. Nothing was changed.",
        });
      }
      const result = this.backend.voiceSessionWatch(
        typeof body.sessionId === "string" ? body.sessionId : "",
        body.on === true,
        Array.isArray(body.cameras)
          ? body.cameras.filter((c): c is string => typeof c === "string")
          : undefined,
      );
      return json(result.ok ? 200 : 409, result);
    }
    // v0.37.0: one Watch frame — one camera's latest view, as
    // {mediaType, data} (the chat photo's wire shape), its
    // perceptual hash when the app computed one, and the
    // turn-refresh mark. The session service shape-checks the
    // frame and refuses an unusable one outright; the body
    // cap matches the chat route's (a frame body is a photo
    // body, whichever door it knocks on). Frames are held in
    // the core's memory only — this route writes nothing.
    if (method === "POST" && path === "/api/voice/session/watch-frame") {
      const body = await this.readJson(req, MAX_CHAT_BODY_BYTES);
      if (!this.backend.voiceSessionWatchFrame) {
        return json(501, {
          ok: false,
          detail: "Watch mode isn't wired in this deployment. The frame was dropped.",
        });
      }
      const result = this.backend.voiceSessionWatchFrame(
        typeof body.sessionId === "string" ? body.sessionId : "",
        typeof body.camera === "string" ? body.camera : "",
        body.image && typeof body.image === "object"
          ? (body.image as PanelChatImageData)
          : undefined,
        typeof body.hash === "string" ? body.hash : undefined,
        body.turnRefresh === true,
      );
      return json(result.ok ? 200 : 409, result);
    }
    // v0.45.0: screen sharing — the app's word that the
    // operator's ReplayKit broadcast started or stopped.
    // The extension's frames ride the watch-frame route
    // above (camera "screen"); this route carries no image
    // data, just the fact. Turning it off drops the held
    // screen frame in the core.
    if (method === "POST" && path === "/api/voice/session/screen-share") {
      const body = await this.readJson(req);
      if (!this.backend.voiceSessionScreenShare) {
        return json(501, {
          ok: false,
          detail: "Screen sharing isn't wired in this deployment. Nothing was changed.",
        });
      }
      const result = this.backend.voiceSessionScreenShare(
        typeof body.sessionId === "string" ? body.sessionId : "",
        body.on === true,
      );
      return json(result.ok ? 200 : 409, result);
    }
    if (method === "POST" && path === "/api/voice/session/audio") {
      const audio = await this.readRaw(req, MAX_SESSION_CHUNK_BYTES);
      const result = this.backend.voiceSessionAudio(
        url.searchParams.get("session") ?? "",
        audio,
      );
      return json(result.ok ? 200 : 409, result);
    }
    if (method === "GET" && path === "/api/voice/session/state") {
      return json(200, this.backend.voiceSessionState(url.searchParams.get("session") ?? ""));
    }
    if (method === "GET" && path === "/api/voice/session/next-audio") {
      const after = Number(url.searchParams.get("after") ?? "0");
      return json(
        200,
        this.backend.voiceSessionNextAudio(
          url.searchParams.get("session") ?? "",
          Number.isFinite(after) && after > 0 ? Math.floor(after) : 0,
        ),
      );
    }
    if (method === "POST" && path === "/api/voice/session/interrupt") {
      const body = await this.readJson(req);
      const result = this.backend.voiceSessionInterrupt(
        typeof body.sessionId === "string" ? body.sessionId : "",
      );
      return json(result.ok ? 200 : 409, result);
    }
    if (method === "POST" && path === "/api/voice/session/end") {
      const body = await this.readJson(req);
      const result = this.backend.voiceSessionEnd(
        typeof body.sessionId === "string" ? body.sessionId : "",
      );
      return json(result.ok ? 200 : 409, result);
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
    // v0.17.8 (Gmail cleanup chunk 4): one cleanup batch's full
    // record — the tap-through behind the morning report's batch
    // + receipt line. GET only: any other method on this path
    // falls through to the 404 below, so this surface cannot
    // mutate anything. Operator-token tier only (deliberately
    // NOT on the device surface): the record enumerates the
    // operator's mail metadata, which a phone credential does
    // not reach. An unwired backend answers 501, never a fake
    // record; an unknown batch answers 404.
    const cleanupBatchMatch = path.match(/^\/api\/gmail-cleanup\/batches\/([^/]+)$/);
    if (method === "GET" && cleanupBatchMatch) {
      if (!this.backend.gmailCleanupBatch) {
        return json(501, { ok: false, detail: "Gmail cleanup batch records aren't wired in this deployment." });
      }
      const batchId = decodeURIComponent(cleanupBatchMatch[1]);
      const batch = this.backend.gmailCleanupBatch(batchId);
      if (!batch) return json(404, { ok: false, detail: `no gmail cleanup batch "${batchId}"` });
      return json(200, batch);
    }
    if (method === "GET" && path === "/api/approvals") return json(200, this.backend.approvals());
    // v0.7: resolution history for the desktop Approvals sidebar —
    // read-only, same token gate as every route above.
    if (method === "GET" && path === "/api/approvals/history") return json(200, this.backend.approvalsHistory());
    if (method === "GET" && path === "/api/vault") return json(200, { names: this.backend.vaultNames() });
    if (method === "GET" && path === "/api/onboarding") return json(200, this.backend.onboarding());
    if (method === "GET" && path === "/api/skills") return json(200, this.backend.skills());
    // v0.10 (Memory Slice A): the context pack — status (files,
    // pending candidates, warnings; hashes/sizes only) and a
    // per-profile preview of the exact pack text a job would
    // receive. Read-only; an unwired backend answers 501, never a
    // fake pack.
    if (method === "GET" && path === "/api/memory/status") {
      if (!this.backend.memoryStatus) {
        return json(501, { detail: "Memory isn't wired in this deployment." });
      }
      return json(200, this.backend.memoryStatus());
    }
    if (method === "GET" && path === "/api/memory/preview") {
      if (!this.backend.memoryPreview) {
        return json(501, {
          ok: false,
          detail: "Memory preview isn't wired in this deployment. Nothing was assembled.",
        });
      }
      const profile = url.searchParams.get("profile") ?? "operator-full";
      const result = await this.backend.memoryPreview(profile);
      return json(200, result);
    }
    // v0.13.0 (Memory Slice B): the Memory inbox + the panel twins
    // of /remember and /forget. Operator-token routes all (none is
    // on the device surface). An unwired backend answers 501,
    // never a fake inbox. /forget without a confirmCount is the
    // search — it changes nothing; with one it applies, and only
    // when the count still matches the search.
    if (method === "GET" && path === "/api/memory/candidates") {
      if (!this.backend.memoryCandidates) {
        return json(501, { ok: false, detail: "The Memory inbox isn't wired in this deployment." });
      }
      return json(200, this.backend.memoryCandidates());
    }
    const candidateMatch = path.match(/^\/api\/memory\/candidates\/([^/]+)\/(promote|reject)$/);
    if (method === "POST" && candidateMatch) {
      const id = decodeURIComponent(candidateMatch[1]);
      if (candidateMatch[2] === "promote") {
        if (!this.backend.promoteCandidate) {
          return json(501, { ok: false, detail: "The Memory inbox isn't wired in this deployment. Nothing was promoted." });
        }
        const body = await this.readJson(req);
        const result = this.backend.promoteCandidate(
          id,
          typeof body.text === "string" ? body.text : undefined,
          typeof body.targetFile === "string" ? body.targetFile : undefined,
        );
        return json(result.ok ? 200 : 400, result);
      }
      if (!this.backend.rejectCandidate) {
        return json(501, { ok: false, detail: "The Memory inbox isn't wired in this deployment. Nothing was rejected." });
      }
      const result = this.backend.rejectCandidate(id);
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/memory/remember") {
      if (!this.backend.memoryRemember) {
        return json(501, { ok: false, detail: "Memory isn't wired in this deployment. Nothing was remembered." });
      }
      const body = await this.readJson(req);
      const result = this.backend.memoryRemember(
        typeof body.text === "string" ? body.text : "",
        typeof body.target === "string" ? body.target : "MEMORY.md",
      );
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/memory/forget") {
      if (!this.backend.memoryForget) {
        return json(501, { ok: false, detail: "Memory isn't wired in this deployment. Nothing was forgotten." });
      }
      const body = await this.readJson(req);
      const result = this.backend.memoryForget(
        typeof body.query === "string" ? body.query : "",
        typeof body.confirmCount === "number" ? body.confirmCount : undefined,
      );
      return json(result.ok ? 200 : 400, result);
    }

    // v0.12.0 (pivot Phase 1 / iPhone Step 1): the device registry
    // + the entitlement readout. v0.13.0 (redo R1): + the identity
    // readout and its local-password/provider settings. Operator-
    // token routes all: a device credential asking for any of
    // these was already refused at the tier gate above (none of
    // them is on the companion's surface). An unwired backend
    // answers 501, never a fake registry or a fake identity.
    if (method === "GET" && path === "/api/devices") {
      if (!this.backend.devices) {
        return json(501, { ok: false, detail: "The device registry isn't wired in this deployment." });
      }
      return json(200, this.backend.devices());
    }
    const deviceRevokeMatch = path.match(/^\/api\/devices\/([^/]+)\/revoke$/);
    if (method === "POST" && deviceRevokeMatch) {
      if (!this.backend.revokeDevice) {
        return json(501, { ok: false, detail: "The device registry isn't wired in this deployment. Nothing was revoked." });
      }
      const result = this.backend.revokeDevice(decodeURIComponent(deviceRevokeMatch[1]));
      return json(result.ok ? 200 : 404, result);
    }
    if (method === "GET" && path === "/api/entitlements") {
      if (!this.backend.entitlements) {
        return json(501, { ok: false, detail: "Entitlements aren't wired in this deployment." });
      }
      return json(200, this.backend.entitlements());
    }
    if (method === "GET" && path === "/api/identity") {
      if (!this.backend.identity) {
        return json(501, { ok: false, detail: "Identity isn't wired in this deployment." });
      }
      return json(200, this.backend.identity());
    }
    if (method === "POST" && path === "/api/identity/password") {
      if (!this.backend.setIdentityPassword) {
        return json(501, { ok: false, detail: "Identity isn't wired in this deployment. No password was set." });
      }
      const body = await this.readJson(req);
      const result = this.backend.setIdentityPassword(
        typeof body.username === "string" ? body.username : "",
        typeof body.password === "string" ? body.password : "",
      );
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/identity/provider") {
      if (!this.backend.setIdentityProvider) {
        return json(501, { ok: false, detail: "Identity isn't wired in this deployment. Nothing changed." });
      }
      const body = await this.readJson(req);
      const result = this.backend.setIdentityProvider(typeof body.kind === "string" ? body.kind : "");
      return json(result.ok ? 200 : 400, result);
    }
    // v0.14.5: the launch gate — session status, sign-in,
    // sign-out, and the first-run welcome marker. Same
    // operator-token tier and 501 discipline as the identity
    // routes above.
    if (method === "GET" && path === "/api/identity/session") {
      if (!this.backend.identitySession) {
        return json(501, { ok: false, detail: "Identity isn't wired in this deployment." });
      }
      return json(200, this.backend.identitySession());
    }
    if (method === "POST" && path === "/api/identity/login") {
      if (!this.backend.identityLogin) {
        return json(501, { ok: false, detail: "Identity isn't wired in this deployment. Nothing was signed in." });
      }
      const body = await this.readJson(req);
      const result = this.backend.identityLogin(
        typeof body.username === "string" ? body.username : "",
        typeof body.password === "string" ? body.password : "",
      );
      return json(result.ok ? 200 : 401, result);
    }
    if (method === "POST" && path === "/api/identity/logout") {
      if (!this.backend.identityLogout) {
        return json(501, { ok: false, detail: "Identity isn't wired in this deployment. Nothing changed." });
      }
      const result = this.backend.identityLogout();
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/identity/welcome") {
      if (!this.backend.identityWelcome) {
        return json(501, { ok: false, detail: "Identity isn't wired in this deployment. Nothing changed." });
      }
      const result = this.backend.identityWelcome();
      return json(result.ok ? 200 : 400, result);
    }
    if (method === "POST" && path === "/api/identity/launch-gate") {
      if (!this.backend.identityLaunchGate) {
        return json(501, { ok: false, detail: "Identity isn't wired in this deployment. Nothing changed." });
      }
      const body = await this.readJson(req);
      const result = this.backend.identityLaunchGate(body.enabled === true);
      return json(result.ok ? 200 : 400, result);
    }

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
    if (method === "POST" && path === "/api/budget-profile") {
      if (!this.backend.setBudgetProfile) {
        return json(501, { ok: false, detail: "Budget profiles aren't wired in this deployment. Nothing changed." });
      }
      const body = await this.readJson(req);
      const result = await this.backend.setBudgetProfile(String(body.profile ?? ""));
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
