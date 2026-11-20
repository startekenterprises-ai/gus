/**
 * Transport — the node-to-node seam (GUS redo build spec §2.4,
 * v0.13.0 R1 groundwork).
 *
 * Why this interface exists: the redo replaces QR pairing and
 * per-device credentials-as-identity with LOGIN identity — one
 * identity, many nodes (the operator's Mac, their phone, later a
 * cloud node), and every node must be able to find and talk to the
 * others with ZERO user configuration. Nobody should ever type an
 * address, scan a code, or paste a token to make two of their own
 * machines see each other. Discovery, connection, and message
 * passing therefore live behind ONE small interface, and everything
 * above it (job dispatch today, shared memory and task coordination
 * in later increments) is written against the interface, never
 * against a wire.
 *
 * Interface now, service later — deliberately. The first
 * implementation (transport-local.ts) is local-network only: UDP
 * announcements plus direct TCP connections between machines on the
 * same network. That covers the desk (Mac + phone on home Wi-Fi)
 * with no account, no server, and no third party in the path. The
 * hosted E2EE relay the spec plans for reaching a node from outside
 * the home network implements THIS SAME interface when it arrives:
 * callers will not change, and the relay — which by design cannot
 * read what it carries — stays a transport detail, not an
 * architectural one.
 *
 * The trust boundary, stated once here because every implementation
 * inherits it: a transport connects nodes OF ONE IDENTITY. A node
 * proves it belongs to the identity during the connection handshake
 * (the local implementation checks a device credential through an
 * injected authenticator — in production wiring that is the
 * DeviceRegistry's digest-only `authenticate`, re-read per call).
 * A node that cannot prove membership gets nothing: no discovery
 * record, no connection, no error detail worth probing. Nodes of a
 * DIFFERENT identity are not refused loudly — they are invisible,
 * exactly as if they were not there, because on a shared network
 * another household's GUS is not an error, it is just not ours.
 *
 * What the transport does NOT do: it does not decide what a message
 * MEANS. Envelopes are routed by `kind` by the consumer
 * (node-dispatch.ts is the first); unknown kinds are ignored by
 * consumers, never rejected by the transport, so a newer node can
 * speak a kind an older node does not know yet without breaking the
 * connection (forward compatibility).
 */

/** A node of the operator's identity, as discovery knows it. */
export interface TransportNodeInfo {
  /** Stable id of this node (one GUS core instance's identity
   *  within the identity — e.g. "node-a" in tests; a generated id
   *  in production). Distinct from `identityId`: many nodes share
   *  one identity. */
  nodeId: string;
  /** The identity these nodes belong to. Discovery only ever
   *  surfaces nodes whose identityId matches the local node's —
   *  see the header: other identities are invisible, not errors. */
  identityId: string;
  /** Human-readable node name (the machine's name, for surfaces
   *  that list nodes). Never used for routing or trust. */
  name: string;
  /** Where the node's TCP listener can be reached, as discovered
   *  (the announcement sender's address). A relay implementation
   *  may carry a relay address here instead — consumers treat it
   *  as opaque and hand it back to `connect`. */
  host: string;
  /** The node's TCP listening port, as announced. */
  port: number;
  /** When this peer was last heard from (epoch ms, local clock) —
   *  discovery refreshes it on every announcement. */
  lastSeenAt: number;
}

/** One message between two nodes. The transport carries envelopes;
 *  it never inspects `payload` — routing by `kind` and interpreting
 *  the payload are the consumer's business. */
export interface TransportEnvelope {
  /** Message kind, routed on by the consumer (e.g.
   *  "job-dispatch", "job-result"). Unknown kinds are ignored by
   *  consumers, not rejected — see the header. */
  kind: string;
  /** Sender nodeId. */
  from: string;
  /** Intended recipient nodeId. */
  to: string;
  /** Unique id for this envelope (correlation lives in the
   *  payload when a consumer needs request/response matching;
   *  this id identifies the envelope itself). */
  id: string;
  /** Consumer-defined body. Treated as opaque JSON data. */
  payload: unknown;
}

/** A live connection to one peer node, post-handshake. */
export interface TransportConnection {
  /** Who is on the other end, as known at connect/handshake time. */
  readonly peer: TransportNodeInfo;
  /** Send one envelope to the peer. Rejects when the connection
   *  is already closed — a send to a gone peer is a fact the
   *  caller should learn, not a silent drop. */
  send(env: TransportEnvelope): Promise<void>;
  /** Register the handler for envelopes arriving on this
   *  connection. One handler per connection (a later registration
   *  replaces an earlier one) — consumers that need fan-out do it
   *  themselves, so there is exactly one obvious owner of each
   *  connection's inbound stream. */
  onMessage(handler: (env: TransportEnvelope) => void): void;
  /** Close the connection. Idempotent; a peer going away is
   *  normal life, never an error worth surfacing. */
  close(): void;
}

/** The transport seam itself — see the header for why it exists
 *  and what its trust boundary is. */
export interface Transport {
  /** This node's own public identity within the transport: who
   *  discovery announces and who envelopes are addressed from. */
  readonly node: { nodeId: string; identityId: string; name: string };
  /** Start listening and announcing. Resolves once the node can
   *  be discovered and can accept connections. */
  start(): Promise<void>;
  /** Stop everything: announcements, listeners, and every live
   *  connection. Idempotent. */
  stop(): Promise<void>;
  /**
   * Discover peer nodes of the SAME identity. Waits `windowMs` so
   * announcements have time to land, then returns every peer heard
   * from so far (including any heard before this call), sorted by
   * nodeId so callers and tests see a stable order. Peers of other
   * identities are never returned — they were never recorded.
   */
  discover(windowMs: number): Promise<TransportNodeInfo[]>;
  /**
   * Open a connection to a discovered peer, performing the
   * identity handshake. Rejects with a plain-language error when
   * the peer cannot be reached, does not answer in time, or
   * refuses the handshake (a node that cannot prove it belongs to
   * the identity gets nothing — and a node WE cannot prove
   * ourselves to gets the same treatment back).
   */
  connect(peer: TransportNodeInfo): Promise<TransportConnection>;
  /** Register the handler for INBOUND connections (peers that
   *  connected to us and passed the handshake). */
  onConnection(handler: (conn: TransportConnection) => void): void;
}
