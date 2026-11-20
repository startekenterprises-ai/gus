/**
 * LocalTransport — the first Transport implementation (redo spec
 * §2.4, v0.13.0 R1): nodes of one identity on one local network,
 * finding each other with zero user configuration.
 *
 * How it works, in two halves:
 *
 *   Discovery — every node holds a UDP socket on the discovery
 *   port and periodically announces itself: a small JSON datagram
 *   naming its nodeId, its identityId, its display name, and the
 *   TCP port it listens on. Announcements go to the configured
 *   discovery endpoints — by default the subnet broadcast address,
 *   so on a home network every node hears every other node without
 *   anyone configuring anything. (Tests and multi-homed setups can
 *   name explicit "host:port" endpoints instead.) Sending uses one
 *   CONNECTED UDP socket per endpoint rather than unconnected
 *   sendto on the listening socket: some sandboxed environments
 *   and strict host firewalls refuse unconnected UDP sends
 *   outright (EPERM) while permitting connected ones — observed
 *   live in the project's own test sandbox — and a connected
 *   sender also surfaces dead endpoints as errors we can quietly
 *   retry instead of datagrams vanishing. The datagrams on the
 *   wire are identical either way; only the socket discipline
 *   differs. A received
 *   announcement is recorded ONLY when its identityId matches this
 *   node's: nodes of a different identity are invisible — not
 *   refused, not logged as errors, simply not there. That is the
 *   polite and the safe behaviour on a shared network at once:
 *   another household's GUS is none of this node's business, and
 *   discovery alone never proves anything anyway — proof is the
 *   handshake's job, below.
 *
 *   Connections — a node listens on TCP, and the wire discipline
 *   is newline-delimited JSON, the same discipline as the comm
 *   protocol (one JSON object per line, no framing surprises). The
 *   FIRST line a connector sends must be a hello naming its node,
 *   its identity, and a credential. The listener checks both: the
 *   identity must be its own AND the credential must authenticate
 *   (an injected check — production wiring passes the
 *   DeviceRegistry's digest-only `authenticate`, which re-reads the
 *   registry per call, so revoking a device cuts its nodes off on
 *   the next connection). On any failure the listener answers with
 *   a refusal line and destroys the socket: a node that cannot
 *   prove it belongs to the identity gets nothing — no envelope is
 *   ever read from it, and the refusal says only that proof failed,
 *   never which part or what would have passed. On success the
 *   listener replies with a welcome line, and from then on both
 *   sides exchange TransportEnvelopes, one per line.
 *
 * Failure posture: peers going away is normal life, not an
 * exception storm — socket errors on established connections close
 * them quietly, and malformed lines are dropped, never thrown.
 * The loud failures are the ones a CALLER caused or must act on:
 * `connect()` rejects, in plain language, when the peer cannot be
 * reached, does not answer in time, or refuses our hello.
 *
 * The credential transits exactly once per connection, inside the
 * hello, over the local network, and is never logged, persisted,
 * or included in any envelope or error by this module.
 */
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import {
  createServer,
  connect as netConnect,
  type Server,
  type Socket,
} from "node:net";
import type {
  Transport,
  TransportConnection,
  TransportEnvelope,
  TransportNodeInfo,
} from "./transport.js";

export interface LocalTransportOptions {
  nodeId: string;
  identityId: string;
  name: string;
  /** This node's own credential, presented in the hello when it
   *  connects to a peer. Held in memory only; never logged. */
  credential: string;
  /** UDP port announcements are sent from and listened on. Nodes
   *  that should discover each other by broadcast share one. */
  discoveryPort: number;
  /** TCP listening port. 0 = an ephemeral port chosen by the OS;
   *  the ANNOUNCED port is always the real one (see
   *  `tcpListeningPort`). */
  tcpPort: number;
  /** "host:port" UDP targets announcements are sent to. Default:
   *  the subnet broadcast address at this node's discovery port. */
  discoveryEndpoints?: string[];
  /** Injected membership proof for INBOUND hellos: true when the
   *  presented credential belongs to this identity. Production
   *  wiring passes the DeviceRegistry's `authenticate` (adapted to
   *  a boolean); tests pass an allowlist. */
  authenticateCredential: (credential: string) => boolean;
  /** How often to announce. Default 1500 ms — frequent enough that
   *  a short discovery window hears a peer, quiet enough to be
   *  nothing on a home network. */
  announceIntervalMs?: number;
}

const HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_ANNOUNCE_INTERVAL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse one "host:port" endpoint, defensively: a malformed
 *  endpoint is skipped, never thrown — discovery configuration is
 *  operator data, and a typo must not take the transport down. */
function parseEndpoint(ep: string): { host: string; port: number } | null {
  const idx = ep.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = ep.slice(0, idx);
  const port = Number(ep.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return { host, port };
}

/** Defensive envelope check for lines arriving after the handshake:
 *  the four routing fields must be strings; the payload is the
 *  consumer's to judge. Anything else is dropped, not thrown. */
function asEnvelope(raw: unknown): TransportEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<TransportEnvelope>;
  if (
    typeof e.kind !== "string" ||
    typeof e.from !== "string" ||
    typeof e.to !== "string" ||
    typeof e.id !== "string"
  ) {
    return null;
  }
  return e as TransportEnvelope;
}

// ------------------------------------------------------------ connection

class LocalConnection implements TransportConnection {
  private handler: ((env: TransportEnvelope) => void) | null = null;
  /** Envelopes that arrived before the consumer registered its
   *  handler (possible when a peer writes immediately after the
   *  handshake). Queued, bounded, and flushed on registration —
   *  a fast peer must not lose its first message to a race. */
  private pending: TransportEnvelope[] = [];
  private closedFlag = false;

  constructor(
    readonly peer: TransportNodeInfo,
    private socket: Socket,
    private onClosed: (conn: LocalConnection) => void,
  ) {}

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Feed one parsed line into this connection (transport-local
   *  internal — the socket plumbing calls this, consumers never
   *  do). Malformed lines are dropped quietly. */
  deliver(raw: unknown): void {
    const env = asEnvelope(raw);
    if (!env || this.closedFlag) return;
    if (this.handler) {
      try {
        this.handler(env);
      } catch {
        /* a consumer's throwing handler must not kill the socket
           plumbing — the envelope is delivered, the fault is the
           consumer's, and the connection stays up */
      }
    } else if (this.pending.length < 100) {
      this.pending.push(env);
    }
  }

  onMessage(handler: (env: TransportEnvelope) => void): void {
    this.handler = handler;
    const queued = this.pending.splice(0);
    for (const env of queued) {
      try {
        handler(env);
      } catch {
        /* same discipline as deliver(): the handler's fault never
           propagates into the transport */
      }
    }
  }

  async send(env: TransportEnvelope): Promise<void> {
    if (this.closedFlag || this.socket.destroyed) {
      throw new Error(
        `the connection to node "${this.peer.nodeId}" is closed — the envelope was not sent`,
      );
    }
    const line = JSON.stringify(env) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.socket.write(line, (err) => {
        if (err) {
          this.close();
          reject(
            new Error(
              `sending to node "${this.peer.nodeId}" failed: ${err.message}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    try {
      this.socket.destroy();
    } catch {
      /* already gone — closing is idempotent by contract */
    }
    this.onClosed(this);
  }
}

// ------------------------------------------------------------ transport

export class LocalTransport implements Transport {
  readonly node: { nodeId: string; identityId: string; name: string };

  private readonly credential: string;
  private readonly discoveryPort: number;
  private readonly requestedTcpPort: number;
  private readonly endpoints: { host: string; port: number }[];
  private readonly authenticateCredential: (credential: string) => boolean;
  private readonly announceIntervalMs: number;

  private peers = new Map<string, TransportNodeInfo>();
  private connections = new Set<LocalConnection>();
  private connectionHandlers: ((conn: TransportConnection) => void)[] = [];
  /** Per-endpoint announcement senders (connected UDP sockets —
   *  see the header for why). Keyed "host:port". An entry whose
   *  socket errors is dropped and recreated on the next announce,
   *  so a dead endpoint costs one quiet retry per interval, never
   *  an exception. */
  private senders = new Map<
    string,
    { socket: UdpSocket; ready: boolean; pending: Buffer | null }
  >();

  private udp: UdpSocket | null = null;
  private server: Server | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private started = false;
  private actualTcpPort = 0;

  constructor(opts: LocalTransportOptions) {
    this.node = {
      nodeId: opts.nodeId,
      identityId: opts.identityId,
      name: opts.name,
    };
    this.credential = opts.credential;
    this.discoveryPort = opts.discoveryPort;
    this.requestedTcpPort = opts.tcpPort;
    this.authenticateCredential = opts.authenticateCredential;
    this.announceIntervalMs =
      typeof opts.announceIntervalMs === "number" && opts.announceIntervalMs > 0
        ? opts.announceIntervalMs
        : DEFAULT_ANNOUNCE_INTERVAL_MS;
    const rawEndpoints = opts.discoveryEndpoints ?? [
      `255.255.255.255:${opts.discoveryPort}`,
    ];
    this.endpoints = rawEndpoints
      .map(parseEndpoint)
      .filter((e): e is { host: string; port: number } => e !== null);
  }

  /** The TCP port this node actually listens on (the announced
   *  one). Meaningful after `start()`; 0 before. */
  get tcpListeningPort(): number {
    return this.actualTcpPort;
  }

  // ---------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // TCP first: announcements must carry the REAL listening port,
    // which for an ephemeral request is known only once the server
    // is bound.
    const server = createServer((sock) => this.onInboundSocket(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.requestedTcpPort, () => {
        server.removeListener("error", reject);
        server.on("error", () => {
          /* a listener error after a successful bind has no caller
             left to throw to — the transport degrades quietly
             rather than crashing the host process */
        });
        resolve();
      });
    });
    const addr = server.address();
    this.actualTcpPort =
      addr && typeof addr === "object" ? addr.port : this.requestedTcpPort;

    // UDP discovery socket. reuseAddr so two nodes on one machine
    // (and a restarting node overlapping its predecessor) can share
    // the discovery port instead of fighting over it. A bind
    // failure REJECTS start(), in plain language: the alternative
    // — a transport that started but can never hear anyone — is a
    // silent half-life the operator cannot diagnose, and a promise
    // that never settles is worse than either.
    const udp = createSocket({ type: "udp4", reuseAddr: true });
    this.udp = udp;
    udp.on("message", (msg, rinfo) => this.onAnnouncement(msg, rinfo.address));
    try {
      await new Promise<void>((resolve, reject) => {
        udp.once("error", (e) => {
          reject(
            new Error(
              `could not listen for node announcements on UDP port ${this.discoveryPort}: ${e.message}`,
            ),
          );
        });
        udp.bind(this.discoveryPort, () => {
          udp.removeAllListeners("error");
          udp.on("error", () => {
            /* discovery is best-effort by nature: a dead UDP socket
               means this node stops hearing peers, which discover()
               reports honestly as an empty neighbourhood — never a
               crash of the host */
          });
          try {
            udp.setBroadcast(true);
          } catch {
            /* explicit endpoints still work without broadcast */
          }
          resolve();
        });
      });
    } catch (e) {
      // Do not leave the TCP half listening behind a failed start.
      this.udp = null;
      this.started = false;
      const srv = this.server;
      this.server = null;
      if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
      throw e;
    }

    this.announce();
    this.announceTimer = setInterval(() => this.announce(), this.announceIntervalMs);
    this.announceTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    for (const key of [...this.senders.keys()]) this.dropSender(key);
    for (const conn of [...this.connections]) conn.close();
    this.connections.clear();
    if (this.udp) {
      const udp = this.udp;
      this.udp = null;
      await new Promise<void>((resolve) => {
        try {
          udp.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    this.started = false;
  }

  // ---------------------------------------------------------- discovery

  /** One announcement datagram to every configured endpoint,
   *  each over its own connected sender socket (see the header).
   *  Send failures are routine — a broadcast route that refuses, a
   *  sandbox that drops UDP, an endpoint that vanished — so they
   *  cost the sender socket (dropped, recreated next interval)
   *  and never throw out of the announce timer. */
  private announce(): void {
    if (!this.udp || this.actualTcpPort === 0) return;
    const payload = Buffer.from(
      JSON.stringify({
        gusTransport: 1,
        nodeId: this.node.nodeId,
        identityId: this.node.identityId,
        name: this.node.name,
        tcpPort: this.actualTcpPort,
      }),
      "utf8",
    );
    for (const ep of this.endpoints) {
      const key = `${ep.host}:${ep.port}`;
      let entry = this.senders.get(key);
      if (!entry) entry = this.createSender(key, ep);
      if (entry.ready) {
        this.sendAnnouncement(key, entry, payload);
      } else {
        // Still connecting: keep only the LATEST announcement —
        // announcements are state refreshes, not a queue, and a
        // stale one flushed late would only re-announce old news
        // a fraction of a second before the next interval anyway.
        entry.pending = payload;
      }
    }
  }

  private createSender(
    key: string,
    ep: { host: string; port: number },
  ): { socket: UdpSocket; ready: boolean; pending: Buffer | null } {
    const socket = createSocket({ type: "udp4" });
    const entry: { socket: UdpSocket; ready: boolean; pending: Buffer | null } = {
      socket,
      ready: false,
      pending: null,
    };
    this.senders.set(key, entry);
    socket.on("error", () => this.dropSender(key));
    try {
      socket.connect(ep.port, ep.host, () => {
        entry.ready = true;
        try {
          // Only meaningful for the broadcast endpoint, and only
          // settable once connect() has implicitly bound the
          // socket — a unicast endpoint does not need it and must
          // not lose its sender over it.
          socket.setBroadcast(true);
        } catch {
          /* unicast endpoints proceed without it */
        }
        if (entry.pending) {
          const pending = entry.pending;
          entry.pending = null;
          this.sendAnnouncement(key, entry, pending);
        }
      });
    } catch {
      this.dropSender(key);
    }
    return entry;
  }

  private sendAnnouncement(
    key: string,
    entry: { socket: UdpSocket; ready: boolean; pending: Buffer | null },
    payload: Buffer,
  ): void {
    try {
      entry.socket.send(payload, (err) => {
        if (err) this.dropSender(key);
      });
    } catch {
      this.dropSender(key);
    }
  }

  private dropSender(key: string): void {
    const entry = this.senders.get(key);
    if (!entry) return;
    this.senders.delete(key);
    try {
      entry.socket.close();
    } catch {
      /* already closed — dropping is idempotent */
    }
  }

  private onAnnouncement(msg: Buffer, fromHost: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(msg.toString("utf8"));
    } catch {
      return; // not JSON — not ours, not an error
    }
    if (!raw || typeof raw !== "object") return;
    const a = raw as Record<string, unknown>;
    if (a.gusTransport !== 1) return;
    if (typeof a.nodeId !== "string" || !a.nodeId) return;
    if (a.nodeId === this.node.nodeId) return; // our own announcement
    // The identity rule (see the header): a node of a different
    // identity is invisible — not recorded, not surfaced, not an
    // error. Discovery alone proves nothing, but it also leaks
    // nothing across identities.
    if (a.identityId !== this.node.identityId) return;
    if (typeof a.tcpPort !== "number" || a.tcpPort <= 0 || a.tcpPort > 65_535) return;
    this.peers.set(a.nodeId, {
      nodeId: a.nodeId,
      identityId: this.node.identityId,
      name: typeof a.name === "string" && a.name ? a.name : a.nodeId,
      host: fromHost,
      port: a.tcpPort,
      lastSeenAt: Date.now(),
    });
  }

  async discover(windowMs: number): Promise<TransportNodeInfo[]> {
    // Nudge the neighbourhood: an announcement from us often
    // prompts nothing by itself, but it refreshes OUR record on
    // peers, and the window below is what actually collects.
    this.announce();
    if (windowMs > 0) await sleep(windowMs);
    return [...this.peers.values()].sort((a, b) =>
      a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
    );
  }

  // ---------------------------------------------------------- connections

  onConnection(handler: (conn: TransportConnection) => void): void {
    this.connectionHandlers.push(handler);
  }

  private emitConnection(conn: LocalConnection): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(conn);
      } catch {
        /* a consumer's throwing onConnection must not break the
           handshake that already succeeded — the connection is
           registered either way */
      }
    }
  }

  private forgetConnection(conn: LocalConnection): void {
    this.connections.delete(conn);
  }

  /** Wire a socket's NDJSON stream into `onLine`, with the quiet
   *  error discipline: socket errors and closes just end the
   *  stream (the caller's onClose decides what that means).
   *  `initial` seeds the buffer (bytes a previous reader already
   *  pulled off the socket — the connect handshake hands its
   *  leftover over this way); complete lines in it are delivered
   *  immediately, a trailing partial line stays buffered. */
  private lineReader(
    sock: Socket,
    onLine: (line: string) => void,
    onClose: () => void,
    initial = "",
  ): void {
    let buf = initial;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      onClose();
    };
    const drain = () => {
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    };
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      drain();
    });
    sock.on("error", finish);
    sock.on("close", finish);
    if (buf.includes("\n")) drain();
  }

  /** Inbound side: the first line must be a hello that proves
   *  membership (see the header); everything after it is
   *  envelopes on a registered connection. */
  private onInboundSocket(sock: Socket): void {
    let conn: LocalConnection | null = null;
    let settled = false;
    this.lineReader(
      sock,
      (line) => {
        if (conn) {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            return; // malformed line on a live connection: dropped
          }
          conn.deliver(raw);
          return;
        }
        if (settled) return;
        settled = true;
        let hello: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (parsed && typeof parsed === "object") {
            hello = parsed as Record<string, unknown>;
          }
        } catch {
          hello = null;
        }
        const refuse = (why: string) => {
          try {
            sock.write(JSON.stringify({ gusRefuse: why }) + "\n", () => {
              sock.destroy();
            });
          } catch {
            sock.destroy();
          }
        };
        if (!hello || hello.gusHello !== 1) {
          refuse("the first message was not a GUS hello — connection refused");
          return;
        }
        if (hello.identityId !== this.node.identityId) {
          refuse("that node belongs to a different identity — connection refused");
          return;
        }
        if (typeof hello.nodeId !== "string" || !hello.nodeId) {
          refuse("the hello named no node — connection refused");
          return;
        }
        let authed = false;
        try {
          authed =
            typeof hello.credential === "string" &&
            this.authenticateCredential(hello.credential);
        } catch {
          authed = false; // a throwing authenticator proves nothing
        }
        if (!authed) {
          // Nothing more specific is said, on purpose: which part
          // failed is information a prober does not get.
          refuse("the credential was not accepted — connection refused");
          return;
        }
        const peer: TransportNodeInfo = {
          nodeId: hello.nodeId,
          identityId: this.node.identityId,
          name:
            typeof hello.name === "string" && hello.name ? hello.name : hello.nodeId,
          host: sock.remoteAddress ?? "",
          port:
            typeof hello.tcpPort === "number" && hello.tcpPort > 0
              ? hello.tcpPort
              : (sock.remotePort ?? 0),
          lastSeenAt: Date.now(),
        };
        conn = new LocalConnection(peer, sock, (c) => this.forgetConnection(c));
        this.connections.add(conn);
        try {
          sock.write(
            JSON.stringify({
              gusWelcome: 1,
              nodeId: this.node.nodeId,
              name: this.node.name,
            }) + "\n",
          );
        } catch {
          conn.close();
          conn = null;
          return;
        }
        this.emitConnection(conn);
      },
      () => {
        conn?.close();
      },
    );
  }

  /** Outbound side: dial, send our hello, and await the welcome —
   *  every failure mode rejects in plain language (see the
   *  Transport contract). */
  async connect(peer: TransportNodeInfo): Promise<TransportConnection> {
    return new Promise<TransportConnection>((resolve, reject) => {
      const sock = netConnect(peer.port, peer.host);
      let done = false;
      let conn: LocalConnection | null = null;
      let timer: NodeJS.Timeout | undefined;
      const fail = (err: Error) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try {
          sock.destroy();
        } catch {
          /* already gone */
        }
        reject(err);
      };
      timer = setTimeout(() => {
        fail(
          new Error(
            `connecting to node "${peer.nodeId}" at ${peer.host}:${peer.port} timed out after ${HELLO_TIMEOUT_MS / 1000} seconds — the peer did not answer the handshake`,
          ),
        );
      }, HELLO_TIMEOUT_MS);
      timer.unref();

      sock.once("connect", () => {
        try {
          sock.write(
            JSON.stringify({
              gusHello: 1,
              nodeId: this.node.nodeId,
              identityId: this.node.identityId,
              name: this.node.name,
              tcpPort: this.actualTcpPort,
              credential: this.credential,
            }) + "\n",
          );
        } catch (e) {
          fail(
            new Error(
              `could not send the handshake to node "${peer.nodeId}": ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      });
      sock.once("error", (e) => {
        if (conn) {
          // An established connection's error is normal life
          // (the peer went away) — close quietly, never throw.
          conn.close();
          return;
        }
        fail(
          new Error(
            `could not connect to node "${peer.nodeId}" at ${peer.host}:${peer.port}: ${e.message}`,
          ),
        );
      });

      let buf = "";
      sock.on("data", (chunk) => {
        if (conn) return; // the connection's own reader owns the stream now
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let raw: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (parsed && typeof parsed === "object") {
              raw = parsed as Record<string, unknown>;
            }
          } catch {
            raw = null;
          }
          if (raw && typeof raw.gusRefuse === "string") {
            fail(
              new Error(
                `node "${peer.nodeId}" refused the connection: ${raw.gusRefuse}`,
              ),
            );
            return;
          }
          if (raw && raw.gusWelcome === 1) {
            done = true;
            if (timer) clearTimeout(timer);
            conn = new LocalConnection(
              { ...peer, lastSeenAt: Date.now() },
              sock,
              (c) => this.forgetConnection(c),
            );
            this.connections.add(conn);
            // Hand the stream over: from here the connection's own
            // NDJSON reader parses envelopes, seeded with whatever
            // bytes past the welcome line this reader had already
            // buffered (`buf` at this point — complete lines in it
            // are delivered by the reader immediately, a trailing
            // partial line stays buffered for the next chunk).
            this.attachEnvelopeReader(sock, conn, buf);
            buf = "";
            resolve(conn);
            return;
          }
          fail(
            new Error(
              `node "${peer.nodeId}" answered the handshake with something that was not a welcome — connection refused`,
            ),
          );
          return;
        }
      });
      sock.once("close", () => {
        if (!done && !conn) {
          fail(
            new Error(
              `the connection to node "${peer.nodeId}" closed before the handshake finished`,
            ),
          );
        }
      });
    });
  }

  /** The post-handshake NDJSON reader for an OUTBOUND connection
   *  (the inbound side reads through onInboundSocket's reader,
   *  which owns its socket from the first byte). */
  private attachEnvelopeReader(
    sock: Socket,
    conn: LocalConnection,
    initial = "",
  ): void {
    this.lineReader(
      sock,
      (line) => {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          return;
        }
        conn.deliver(raw);
      },
      () => conn.close(),
      initial,
    );
  }
}
