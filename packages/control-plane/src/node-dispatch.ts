/**
 * Node job dispatch — one GUS core handing a job to another core
 * of the same identity over a Transport (redo spec §2.4, v0.13.0
 * R1; the transport seam is transport.ts).
 *
 * The shape, end to end:
 *
 *   1. The dispatching core (NodeDispatcher) creates a LOCAL job
 *      for the work — dispatch is never invisible labour: the
 *      operator's own job list shows that a job was sent to a peer,
 *      and it settles with a receipt like every other job.
 *   2. It connects to the peer and sends one "job-dispatch"
 *      envelope carrying the input and a `dispatchId` correlation
 *      token minted for this dispatch.
 *   3. The receiving core (NodeJobHandler) creates ITS OWN job for
 *      the work (conversation `node:<sender>` — the record says
 *      plainly which node asked), runs the Shield gate over the
 *      inbound input on the "node-dispatch" surface before anything
 *      executes, and only then produces a reply. A gate block
 *      settles the remote job failed-loudly WITH the scan's receipt
 *      as its settlement receipt — the block is the outcome, and it
 *      is receipted by the scan that decided it, exactly like a
 *      Shield-blocked tool call (jobs.ts).
 *   4. The handler answers on the SAME connection with a
 *      "job-result" envelope echoing the `dispatchId`, naming its
 *      job, its settled state, its settlement receipt, every Shield
 *      receipt the job collected, and the reply text.
 *   5. The dispatcher matches the result by `dispatchId` (a result
 *      for some other dispatch is not this dispatch's answer),
 *      links the remote receipts onto its local job, and settles
 *      the local job to MATCH the remote outcome: verified-done
 *      only when the remote job verified-done, failed-loudly
 *      otherwise. A dispatch that gets no answer in time settles
 *      its local job failed-loudly and throws — silence is never a
 *      success and never a hang.
 *
 * The receipt chain: dispatch returns the hop-ordered chain
 *   [ remote Shield receipts…, remote settlement receipt,
 *     local settlement receipt ]
 * It is verified BY CONSTRUCTION, and that phrase is meant
 * literally: every id in the chain is copied out of a job record —
 * the remote job's `shieldReceiptIds` / `receiptId` as the handler
 * reported them from its own JobRunner, and this core's local
 * job's `receiptId` read back after settlement — so each id
 * resolves in one of the two jobs' records, with nothing minted,
 * re-typed, or trusted from the wire beyond what the receiving
 * core's own runner settled. The two-node test asserts exactly
 * that resolution property.
 *
 * What runs the job on the receiving side, for now: the
 * deterministic stub (`fakeComplete`, provider.ts) — R1 proves the
 * dispatch, settlement, and receipt plumbing between two real
 * cores; routing a dispatched job through the receiving core's full
 * runtime is a later increment and changes nothing about the
 * envelope shapes here.
 *
 * Forward compatibility: envelope kinds neither class knows are
 * ignored, never answered with an error — a newer node can speak
 * first and an older node simply does not reply (the newer node's
 * own timeout is what bounds that conversation).
 */
import { randomUUID } from "node:crypto";
import type { JobKind } from "@gus/shared";
import type { JobRunner } from "./jobs.js";
import { fakeComplete } from "./provider.js";
import type {
  Transport,
  TransportConnection,
  TransportEnvelope,
  TransportNodeInfo,
} from "./transport.js";

/**
 * The Shield gate seam for dispatched work, structurally — the
 * real ShieldGate satisfies it (its scanSurface takes the surface
 * as a GateSurface; "node-dispatch" widens that union when the
 * handler is wired in production), and tests substitute the same
 * fake the context-pack tests use. Declared here so dispatch
 * depends on the contract, not the gate package — the comm-server
 * discipline (see FetchGate / GmailGate there).
 */
export interface NodeGateSeam {
  scanSurface(
    surface: string,
    jobId: string,
    content: string,
  ): Promise<{
    action: "allow" | "block" | "flag";
    receipt?: { receiptId: string };
    detail: string;
  }>;
}

/** The "job-dispatch" payload, as the handler reads it. Fields are
 *  judged defensively at read time — this object crossed a wire. */
interface DispatchPayload {
  input: string;
  kind?: string;
  dispatchId?: string;
}

/** The "job-result" payload, as the dispatcher reads it. */
interface ResultPayload {
  dispatchId?: string;
  remoteJobId: string;
  state: string;
  receiptId?: string;
  shieldReceiptIds: string[];
  replyText?: string;
}

const DISPATCH_TIMEOUT_MS = 10_000;

const JOB_KINDS: readonly string[] = [
  "chat",
  "task",
  "digest",
  "fetch-summarize",
  "workspace-file",
  "reminder",
  "slow-demo",
  "loop-demo",
  "canary",
  "update",
];

/** A wire-supplied job kind is a hint, not authority: anything
 *  that is not a real JobKind falls back to "chat" rather than
 *  reaching the JobRunner as an invented kind. */
function asJobKind(raw: unknown): JobKind {
  return typeof raw === "string" && JOB_KINDS.includes(raw)
    ? (raw as JobKind)
    : "chat";
}

function asDispatchPayload(raw: unknown): DispatchPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.input !== "string") return null;
  return {
    input: p.input,
    kind: typeof p.kind === "string" ? p.kind : undefined,
    dispatchId: typeof p.dispatchId === "string" ? p.dispatchId : undefined,
  };
}

function asResultPayload(raw: unknown): ResultPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.remoteJobId !== "string" || !p.remoteJobId) return null;
  if (typeof p.state !== "string" || !p.state) return null;
  return {
    dispatchId: typeof p.dispatchId === "string" ? p.dispatchId : undefined,
    remoteJobId: p.remoteJobId,
    state: p.state,
    receiptId:
      typeof p.receiptId === "string" && p.receiptId ? p.receiptId : undefined,
    shieldReceiptIds: Array.isArray(p.shieldReceiptIds)
      ? p.shieldReceiptIds.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [],
    replyText: typeof p.replyText === "string" ? p.replyText : undefined,
  };
}

// ------------------------------------------------------------ handler

/** The receiving half: serves "job-dispatch" envelopes arriving on
 *  any connection of the attached transport. */
export class NodeJobHandler {
  constructor(
    private deps: { jobs: JobRunner; gate?: NodeGateSeam },
  ) {}

  /** Serve dispatches on this transport. Every inbound connection
   *  gets the same message handler; connections themselves are the
   *  transport's business. */
  attach(transport: Transport): void {
    transport.onConnection((conn) => {
      conn.onMessage((env) => {
        void this.onEnvelope(transport, conn, env);
      });
    });
  }

  private async onEnvelope(
    transport: Transport,
    conn: TransportConnection,
    env: TransportEnvelope,
  ): Promise<void> {
    // Unknown kinds are ignored (forward compatibility — see the
    // header). Only "job-dispatch" is this class's business.
    if (env.kind !== "job-dispatch") return;
    const payload = asDispatchPayload(env.payload);
    if (!payload) return; // a dispatch with no readable input has no job to settle and no one to answer usefully

    const jobs = this.deps.jobs;
    const job = jobs.create(
      asJobKind(payload.kind),
      `node:${env.from}`,
      payload.input,
    );
    jobs.transition(job.id, "running");

    const reply = async (result: Omit<ResultPayload, "dispatchId">) => {
      const full: ResultPayload = {
        ...result,
        ...(payload.dispatchId ? { dispatchId: payload.dispatchId } : {}),
      };
      try {
        await conn.send({
          kind: "job-result",
          from: transport.node.nodeId,
          to: env.from,
          id: `env_${randomUUID()}`,
          payload: full,
        });
      } catch {
        /* the dispatcher is gone — its own timeout settles its
           side failed-loudly; there is no one left to tell here */
      }
    };

    // The gate crosses the inbound input BEFORE anything runs
    // (scan-before-act, the same choke-point discipline as every
    // other surface). A block is terminal and receipted by the
    // scan itself.
    if (this.deps.gate) {
      const scan = await this.deps.gate.scanSurface(
        "node-dispatch",
        job.id,
        payload.input,
      );
      if (scan.action === "block") {
        const settled = jobs.transition(
          job.id,
          "failed-loudly",
          `blocked by the Agent-Shield gate on arrival from node "${env.from}": ${scan.detail}`,
          scan.receipt ? { shieldReceiptId: scan.receipt.receiptId } : undefined,
        );
        await reply({
          remoteJobId: job.id,
          state: settled.state,
          receiptId: settled.receiptId,
          shieldReceiptIds: settled.shieldReceiptIds ?? [],
        });
        return;
      }
      // Allow / flag: the scan's receipt joins the job's record,
      // so it rides the result (and the dispatcher's chain) like
      // every other gated surface's receipt.
      if (scan.receipt) jobs.noteShieldReceipt(job.id, scan.receipt.receiptId);
    }

    let replyText: string | undefined;
    try {
      const completion = fakeComplete(payload.input);
      replyText = completion.text;
    } catch (e) {
      const settled = jobs.transition(
        job.id,
        "failed-loudly",
        `the dispatched job failed on node "${transport.node.nodeId}": ${e instanceof Error ? e.message : String(e)}`,
      );
      await reply({
        remoteJobId: job.id,
        state: settled.state,
        receiptId: settled.receiptId,
        shieldReceiptIds: settled.shieldReceiptIds ?? [],
      });
      return;
    }

    const settled = jobs.transition(
      job.id,
      "verified-done",
      `dispatched job from node "${env.from}" completed on node "${transport.node.nodeId}"`,
    );
    await reply({
      remoteJobId: job.id,
      state: settled.state,
      receiptId: settled.receiptId,
      shieldReceiptIds: settled.shieldReceiptIds ?? [],
      ...(replyText !== undefined ? { replyText } : {}),
    });
  }
}

// ------------------------------------------------------------ dispatcher

/** What a completed dispatch hands back: both jobs' identities,
 *  the settled state (the remote outcome — the local job is
 *  settled to match before this resolves), the hop-ordered
 *  receipt chain (see the header), and the reply text when the
 *  remote job produced one. */
export interface DispatchResult {
  localJobId: string;
  remoteJobId: string;
  state: string;
  receiptChain: string[];
  replyText?: string;
}

/** The sending half: dispatches one job to one peer per call. */
export class NodeDispatcher {
  constructor(
    private deps: { jobs: JobRunner },
  ) {}

  async dispatch(
    transport: Transport,
    peer: TransportNodeInfo,
    input: string,
  ): Promise<DispatchResult> {
    const jobs = this.deps.jobs;
    const local = jobs.create("chat", `node:${peer.nodeId}`, input);
    jobs.transition(local.id, "running");
    const dispatchId = `dispatch_${randomUUID()}`;

    let conn: TransportConnection | null = null;
    try {
      conn = await transport.connect(peer);
    } catch (e) {
      jobs.transition(
        local.id,
        "failed-loudly",
        `dispatch to node "${peer.nodeId}" never left this node: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }

    try {
      const result = await new Promise<ResultPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `node "${peer.nodeId}" did not answer the dispatch within ${DISPATCH_TIMEOUT_MS / 1000} seconds`,
            ),
          );
        }, DISPATCH_TIMEOUT_MS);
        timer.unref();
        conn!.onMessage((env) => {
          if (env.kind !== "job-result") return; // not ours to judge — forward compatibility cuts both ways
          const payload = asResultPayload(env.payload);
          if (!payload) return;
          // Correlation: only the result that echoes THIS
          // dispatch's id is this dispatch's answer. An unmatched
          // result (a stale connection, a confused peer) is
          // ignored and the timeout remains the bound.
          if (payload.dispatchId !== dispatchId) return;
          clearTimeout(timer);
          resolve(payload);
        });
        conn!
          .send({
            kind: "job-dispatch",
            from: transport.node.nodeId,
            to: peer.nodeId,
            id: `env_${randomUUID()}`,
            payload: { input, dispatchId },
          })
          .catch((e: unknown) => {
            clearTimeout(timer);
            reject(
              e instanceof Error
                ? e
                : new Error(`sending the dispatch to node "${peer.nodeId}" failed`),
            );
          });
      });

      // Link the remote hops onto the local record BEFORE settling,
      // so the local job's durable record names every receipt the
      // work collected on the far side (the settlement receipt and
      // each Shield receipt alike).
      for (const id of result.shieldReceiptIds) {
        jobs.noteShieldReceipt(local.id, id);
      }
      if (result.receiptId) jobs.noteShieldReceipt(local.id, result.receiptId);

      const remoteOk = result.state === "verified-done";
      const settled = jobs.transition(
        local.id,
        remoteOk ? "verified-done" : "failed-loudly",
        remoteOk
          ? `completed on node "${peer.nodeId}" as remote job ${result.remoteJobId}` +
              (result.receiptId ? ` (remote receipt ${result.receiptId})` : "")
          : `node "${peer.nodeId}" settled remote job ${result.remoteJobId} as ${result.state}` +
              (result.receiptId ? ` (remote receipt ${result.receiptId})` : ""),
      );

      // Hop order: the remote job's Shield receipts first (they
      // were issued first, on arrival), then its settlement
      // receipt, then this node's own settlement receipt last —
      // the chain reads in the order the work actually happened.
      const receiptChain = [
        ...result.shieldReceiptIds,
        ...(result.receiptId ? [result.receiptId] : []),
        ...(settled.receiptId ? [settled.receiptId] : []),
      ].filter((id) => id.length > 0);

      return {
        localJobId: local.id,
        remoteJobId: result.remoteJobId,
        state: result.state,
        receiptChain,
        ...(result.replyText !== undefined ? { replyText: result.replyText } : {}),
      };
    } catch (e) {
      // No answer (or no send): the local job settles failed-loudly
      // — a dispatch is a job, and a job never hangs unsettled.
      try {
        jobs.transition(
          local.id,
          "failed-loudly",
          `dispatch to node "${peer.nodeId}" failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      } catch {
        /* already settled — the throw below still stands */
      }
      throw e;
    } finally {
      conn.close();
    }
  }
}
