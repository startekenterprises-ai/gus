/**
 * Receipt issuing (foundation spec §1.5).
 *
 * PHASE 0 STUB — read this before believing anything: this module produces
 * LOCALLY-SIGNED, Protocol-SHAPED receipts (same fields: ids, verdict/state,
 * content hash only, timestamps) so the job pipeline can be built and
 * drilled end-to-end. It is NOT the Agent-Shield Protocol integration: the
 * real signed receipts come from the Agent-Shield worker (scan API +
 * /v1/receipts/verify) and are wired at the gate choke points in Phase 4.
 * Every stub receipt is stamped kind:"gus-local-stub" so nothing downstream
 * can mistake it for a Shield receipt.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

export interface Receipt {
  kind: "gus-local-stub";
  receiptId: string;
  jobId: string;
  state: string;
  /** sha256 of the job's redacted input — hash, never content. */
  contentHash: string;
  costUsd: number;
  issuedAt: number;
  /** HMAC over the canonical receipt body with the local stub key. */
  signature: string;
  note: "Phase 0 local stub — real Agent-Shield Protocol receipts integrate in Phase 4.";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class LocalReceiptIssuer {
  private key: Buffer;

  /** keyPath lives in control-plane state; created 0600 on first use. */
  constructor(keyPath: string) {
    if (existsSync(keyPath)) {
      this.key = readFileSync(keyPath);
    } else {
      this.key = randomBytes(32);
      writeFileSync(keyPath, this.key, { mode: 0o600 });
      chmodSync(keyPath, 0o600);
    }
  }

  issue(input: {
    jobId: string;
    state: string;
    contentHash: string;
    costUsd: number;
  }): Receipt {
    const issuedAt = Date.now();
    const receiptId = "gus_rcpt_" + sha256Hex(`${input.jobId}:${issuedAt}:${Math.random()}`).slice(0, 16);
    const body = [receiptId, input.jobId, input.state, input.contentHash, String(input.costUsd), String(issuedAt)].join("|");
    const signature = createHmac("sha256", this.key).update(body).digest("hex");
    return {
      kind: "gus-local-stub",
      receiptId,
      jobId: input.jobId,
      state: input.state,
      contentHash: input.contentHash,
      costUsd: input.costUsd,
      issuedAt,
      signature,
      note: "Phase 0 local stub — real Agent-Shield Protocol receipts integrate in Phase 4.",
    };
  }

  verify(r: Receipt): boolean {
    const body = [r.receiptId, r.jobId, r.state, r.contentHash, String(r.costUsd), String(r.issuedAt)].join("|");
    const expect = createHmac("sha256", this.key).update(body).digest("hex");
    return expect === r.signature && r.kind === "gus-local-stub";
  }
}
