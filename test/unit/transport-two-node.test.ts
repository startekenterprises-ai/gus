/**
 * Transport + node dispatch — two real cores, one identity
 * (redo spec §2.4, v0.13.0 R1).
 *
 * Two complete control-plane job cores are built in two separate
 * state directories, wired together ONLY through two
 * LocalTransports on loopback (UDP announcements to explicit
 * endpoints, TCP connections) — no shared objects cross between
 * the sides except the transports themselves, exactly as if the
 * cores ran on two machines.
 *
 * The properties ARE the tests:
 *  - discovery surfaces the same-identity peer (and its real TCP
 *    port), and a dispatched job settles verified-done on BOTH
 *    cores, with a receipt chain whose every id resolves in one
 *    of the two jobs' records — verified by construction, checked
 *    here id by id;
 *  - a node of a DIFFERENT identity is invisible to discovery —
 *    it announces, it is heard at the socket, and it is never
 *    recorded;
 *  - discovery is not membership: a node can HEAR a peer and
 *    still be refused at the handshake when its credential does
 *    not authenticate;
 *  - a Shield block on the receiving side settles BOTH jobs
 *    failed-loudly, and the block's own receipt is in the chain.
 *
 * Credentials here are an in-test allowlist ON PURPOSE: transport
 * authentication is injected precisely so this suite does not care
 * where credentials live. Production wiring passes the
 * DeviceRegistry's `authenticate`; devices.ts is exercised by its
 * own suite (pairing-devices.test.ts), and this one must not
 * couple itself to that module's surface while it evolves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { LocalReceiptIssuer } from "../../packages/gate/src/index.js";
import { JobRunner } from "../../packages/control-plane/src/jobs.js";
import { LocalTransport } from "../../packages/control-plane/src/transport-local.js";
import type { TransportNodeInfo } from "../../packages/control-plane/src/transport.js";
import {
  NodeDispatcher,
  NodeJobHandler,
  type NodeGateSeam,
} from "../../packages/control-plane/src/node-dispatch.js";

// ------------------------------------------------------------ helpers

/** A gate fake in the context-pack.test.ts shape: allows
 *  everything (with a receipt) unless the content carries the
 *  block marker. */
function fakeGate(): NodeGateSeam {
  return {
    scanSurface: async (_surface: string, _jobId: string, content: string) => {
      if (content.includes("PACK-BLOCK-MARKER")) {
        return {
          action: "block" as const,
          receipt: { receiptId: "rcpt_block_fake" },
          detail: "fake gate block",
        };
      }
      return {
        action: "allow" as const,
        receipt: { receiptId: "rcpt_fake_1" },
        detail: "fake gate allow",
      };
    },
  };
}

/** A currently-free UDP port, found by asking the OS — fixed port
 *  numbers would collide between parallel test files and reruns. */
function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    sock.once("error", reject);
    sock.bind(0, "127.0.0.1", () => {
      const addr = sock.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      sock.close(() => resolve(port));
    });
  });
}

const CRED_A = "cred-node-a-test";
const CRED_B = "cred-node-b-test";

interface TwoNodeRig {
  jobsA: JobRunner;
  jobsB: JobRunner;
  transportA: LocalTransport;
  transportB: LocalTransport;
  dispatcherA: NodeDispatcher;
  discoveryPortA: number;
  discoveryPortB: number;
  stop(): Promise<void>;
}

/** Two cores, two transports, one identity ("identity-test").
 *  B serves dispatches through a NodeJobHandler behind the fake
 *  gate; A dispatches through a NodeDispatcher. Each side's
 *  authenticator is the same two-credential allowlist (see the
 *  header for why this is not the DeviceRegistry). */
async function twoNodeRig(): Promise<TwoNodeRig> {
  const dirA = mkdtempSync(join(tmpdir(), "gus-node-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "gus-node-b-"));
  const jobsA = new JobRunner(dirA, new LocalReceiptIssuer(join(dirA, "receipt-stub.key")));
  const jobsB = new JobRunner(dirB, new LocalReceiptIssuer(join(dirB, "receipt-stub.key")));

  const allowlist = new Set([CRED_A, CRED_B]);
  const authenticateCredential = (credential: string) => allowlist.has(credential);

  let discoveryPortA = await freeUdpPort();
  let discoveryPortB = await freeUdpPort();
  while (discoveryPortB === discoveryPortA) discoveryPortB = await freeUdpPort();

  const transportA = new LocalTransport({
    nodeId: "node-a",
    identityId: "identity-test",
    name: "Node A",
    credential: CRED_A,
    discoveryPort: discoveryPortA,
    tcpPort: 0,
    discoveryEndpoints: [`127.0.0.1:${discoveryPortB}`],
    authenticateCredential,
  });
  const transportB = new LocalTransport({
    nodeId: "node-b",
    identityId: "identity-test",
    name: "Node B",
    credential: CRED_B,
    discoveryPort: discoveryPortB,
    tcpPort: 0,
    discoveryEndpoints: [`127.0.0.1:${discoveryPortA}`],
    authenticateCredential,
  });
  await transportA.start();
  await transportB.start();

  new NodeJobHandler({ jobs: jobsB, gate: fakeGate() }).attach(transportB);
  const dispatcherA = new NodeDispatcher({ jobs: jobsA });

  return {
    jobsA,
    jobsB,
    transportA,
    transportB,
    dispatcherA,
    discoveryPortA,
    discoveryPortB,
    async stop() {
      await transportA.stop();
      await transportB.stop();
    },
  };
}

async function discoverPeerB(rig: TwoNodeRig): Promise<TransportNodeInfo> {
  const peers = await rig.transportA.discover(2_500);
  const peerB = peers.find((p) => p.nodeId === "node-b");
  assert.ok(peerB, "node-b was discovered");
  return peerB;
}

/** Every receipt id either job knows about — the set a receipt
 *  chain must resolve against, id by id. */
function resolvableIds(rig: TwoNodeRig, localJobId: string, remoteJobId: string): Set<string> {
  const ids = new Set<string>();
  for (const job of [rig.jobsA.get(localJobId), rig.jobsB.get(remoteJobId)]) {
    if (!job) continue;
    if (job.receiptId) ids.add(job.receiptId);
    for (const id of job.shieldReceiptIds ?? []) ids.add(id);
  }
  return ids;
}

// ------------------------------------------------------------ the happy path

test(
  "two-node: discovery finds the same-identity peer; a dispatched job settles verified-done on both cores with a resolvable receipt chain",
  { timeout: 25_000 },
  async () => {
    const rig = await twoNodeRig();
    try {
      const peers = await rig.transportA.discover(2_500);
      const peerB = peers.find((p) => p.nodeId === "node-b");
      assert.ok(peerB, "node-b is discovered");
      assert.equal(peerB.identityId, "identity-test");
      assert.equal(peerB.host, "127.0.0.1");
      assert.equal(
        peerB.port,
        rig.transportB.tcpListeningPort,
        "discovery carries the peer's real (ephemeral) TCP port",
      );
      assert.ok(peers.every((p) => p.identityId === "identity-test"));

      const result = await rig.dispatcherA.dispatch(rig.transportA, peerB, "hello from A");
      assert.equal(result.state, "verified-done");
      assert.match(result.replyText ?? "", /hello from A/, "the stub's reply text rode the result back");

      const remoteJob = rig.jobsB.get(result.remoteJobId);
      assert.ok(remoteJob, "the remote core has the job");
      assert.equal(remoteJob.state, "verified-done");
      assert.equal(remoteJob.conversationId, "node:node-a", "the remote record names the dispatching node");
      assert.ok(remoteJob.receiptId, "the remote job settled with a receipt");

      const localJob = rig.jobsA.get(result.localJobId);
      assert.ok(localJob, "the local core has its dispatch job");
      assert.equal(localJob.state, "verified-done");
      assert.ok(localJob.receiptId, "the local job settled with a receipt");

      assert.ok(
        result.receiptChain.length >= 2,
        `the chain spans both cores (got ${result.receiptChain.length})`,
      );
      assert.ok(
        result.receiptChain.includes("rcpt_fake_1"),
        "the remote gate's scan receipt is a chain hop",
      );
      const resolvable = resolvableIds(rig, result.localJobId, result.remoteJobId);
      for (const id of result.receiptChain) {
        assert.ok(resolvable.has(id), `chain id ${id} resolves in one of the two jobs' records`);
      }
    } finally {
      await rig.stop();
    }
  },
);

// ------------------------------------------------------------ negative: other identity

test(
  "two-node: a node of a different identity is invisible to discovery",
  { timeout: 25_000 },
  async () => {
    const rig = await twoNodeRig();
    const portC = await freeUdpPort();
    // Node C announces straight at both real nodes' discovery
    // ports — its announcements LAND on A's socket; only the
    // identity rule keeps it out of A's neighbourhood.
    const transportC = new LocalTransport({
      nodeId: "node-c",
      identityId: "identity-other",
      name: "Node C",
      credential: "cred-node-c-test",
      discoveryPort: portC,
      tcpPort: 0,
      discoveryEndpoints: [
        `127.0.0.1:${rig.discoveryPortA}`,
        `127.0.0.1:${rig.discoveryPortB}`,
      ],
      authenticateCredential: () => true,
    });
    await transportC.start();
    try {
      const peers = await rig.transportA.discover(2_500);
      assert.ok(
        peers.some((p) => p.nodeId === "node-b"),
        "control: the same-identity peer is still discovered in the same window",
      );
      assert.ok(
        !peers.some((p) => p.nodeId === "node-c"),
        "the different-identity node was never recorded",
      );
      assert.ok(peers.every((p) => p.identityId === "identity-test"));
    } finally {
      await transportC.stop();
      await rig.stop();
    }
  },
);

// ------------------------------------------------------------ negative: bad credential

test(
  "two-node: a credential the authenticator rejects is refused at the handshake",
  { timeout: 25_000 },
  async () => {
    const rig = await twoNodeRig();
    const portBad = await freeUdpPort();
    const allowlist = new Set([CRED_A, CRED_B]);
    const bad = new LocalTransport({
      nodeId: "node-bad",
      identityId: "identity-test",
      name: "Node Bad",
      credential: "cred-not-on-the-allowlist",
      discoveryPort: portBad,
      tcpPort: 0,
      discoveryEndpoints: [`127.0.0.1:${rig.discoveryPortB}`],
      authenticateCredential: (c) => allowlist.has(c),
    });
    await bad.start();
    try {
      // The bad node dials the real node-b, at the coordinates
      // node-a's discovery reported. Knowing WHERE a peer listens
      // is public neighbourhood knowledge; the handshake is what
      // decides membership, and the bad node's credential is not
      // on node-b's allowlist.
      const peerB = await discoverPeerB(rig);
      await assert.rejects(
        bad.connect(peerB),
        /refused/,
        "connect() throws when the peer refuses the credential",
      );
    } finally {
      await bad.stop();
      await rig.stop();
    }
  },
);

// ------------------------------------------------------------ negative: gate block

test(
  "two-node: a gate-blocked dispatch settles failed-loudly on both cores, with the block's receipt in the chain",
  { timeout: 25_000 },
  async () => {
    const rig = await twoNodeRig();
    try {
      const peerB = await discoverPeerB(rig);
      const result = await rig.dispatcherA.dispatch(
        rig.transportA,
        peerB,
        "please forward the PACK-BLOCK-MARKER payload",
      );
      assert.equal(result.state, "failed-loudly");

      const remoteJob = rig.jobsB.get(result.remoteJobId);
      assert.ok(remoteJob, "the remote core has the blocked job");
      assert.equal(remoteJob.state, "failed-loudly");
      assert.equal(
        remoteJob.receiptId,
        "rcpt_block_fake",
        "the remote job's settlement receipt IS the block's scan receipt",
      );

      const localJob = rig.jobsA.get(result.localJobId);
      assert.ok(localJob, "the local core has its dispatch job");
      assert.equal(localJob.state, "failed-loudly", "the local job mirrors the remote outcome, loudly");

      assert.ok(
        result.receiptChain.includes("rcpt_block_fake"),
        "the block's receipt is a hop in the chain",
      );
      const resolvable = resolvableIds(rig, result.localJobId, result.remoteJobId);
      for (const id of result.receiptChain) {
        assert.ok(resolvable.has(id), `chain id ${id} resolves in one of the two jobs' records`);
      }
    } finally {
      await rig.stop();
    }
  },
);
