/**
 * The turn queue (v0.3.4) — serializes agent turns in the runtime.
 *
 * Field root cause (2026-11-05, 23:15): two jobs pushed eight
 * seconds apart (a delegate bridge request and the operator's own
 * group message) ran CONCURRENT driveLoops. Response waiters match
 * by message type only — the design always assumed one active turn
 * (see the `currentTurn` singleton) — so the first model_response
 * to land resolved both loops: one job delivered the other job's
 * model text, its Governor post-condition hash mismatched, and it
 * failed loudly while the other verified. Nothing unsafe was
 * delivered (the post-condition did its job), but concurrency was
 * never a designed state. This queue restores the invariant the
 * rest of the runtime is built on: turns run one at a time, in
 * arrival order; a failing turn never jams the ones behind it.
 */
export class TurnQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch(() => undefined);
  }

  /** Resolves when everything queued so far has finished. */
  idle(): Promise<void> {
    return this.chain;
  }
}
