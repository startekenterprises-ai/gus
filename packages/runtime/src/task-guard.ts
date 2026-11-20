/**
 * The task guard (v0.14.3) — the runtime half.
 *
 * Why this exists: v0.14.1 made kind "task" a routing label whose
 * only effect was execution framing appended to the prompt. Two
 * real Cycle 0 runs of the self-build loop (2026-11-18 on the
 * pre-label path, 2026-11-19 on v0.14.2) died the same way: the
 * model answered the multi-step instruction in prose on the first
 * hop, the loop finalized on that text exactly like a chat job,
 * and the job settled failed-loudly on its deliverable
 * post-condition having executed nothing. A prompt cannot enforce
 * a control-flow invariant; the loop has to.
 *
 * The guard makes "task" structural. While a task job has executed
 * ZERO tool calls, a plain-text (final-answer) model reply does
 * NOT finalize the job. The loop instead serves a continuation
 * turn — a short instruction that no tool has been called yet and
 * this job requires tool execution, plus a minimal JSON skeleton
 * in the exact TOOL_PROTOCOL shape (providers.ts) with one
 * concrete example, so the model can copy the syntax instead of
 * describing the work again. At most TASK_GUARD_MAX_CONTINUATIONS
 * continuations are served. The first executed tool call
 * disengages the guard permanently for the job; from there the
 * normal finalize rules apply, untouched.
 *
 * Exhaustion is an EXPLICIT failure, never a silent success: the
 * runtime reports it with the TASK_GUARD_EXHAUSTED_NOTE_PREFIX
 * job_update (see @gus/shared comm.ts) and the control plane
 * settles the job failed-loudly with the cause on its record.
 *
 * Scope discipline: the guard is active ONLY for kind "task"
 * jobs. Every other kind gets an inactive guard whose every
 * verdict is "finalize" — the pre-guard loop, byte for byte. The
 * Governor's caps remain the only spend brake: continuations are
 * ordinary model calls inside the job's existing budget, and the
 * hop ceiling stays a liveness backstop, exactly as before.
 */
import { TASK_GUARD_EXHAUSTED_NOTE_PREFIX } from "@gus/shared";

/** Continuations served to a task job that has not called a tool
 *  yet before the guard gives up and fails the job loudly. Kept
 *  low on purpose (panel review, 2026-11-19): a model that cannot
 *  produce a valid tool call should burn a couple of bounded
 *  retries, not a budget. */
export const TASK_GUARD_MAX_CONTINUATIONS = 2;

export type TaskGuardVerdict = "finalize" | "continue" | "exhausted";

export class TaskGuard {
  private continuations = 0;
  private toolCalls: number;

  constructor(
    readonly active: boolean,
    toolCallsSoFar = 0,
  ) {
    this.toolCalls = toolCallsSoFar;
  }

  /** A fresh turn for a job of the given kind. The kind arrives on
   *  the `user_message` itself — set by the control plane from the
   *  job record, never inferred from message text. */
  static forJob(kind: string): TaskGuard {
    return new TaskGuard(kind === "task");
  }

  /** A loop entered after a tool already executed (the
   *  approved-execution continuation in main.ts): the guard's
   *  condition — zero tool calls — is already false and can never
   *  trigger, whatever the job's kind. */
  static afterToolExecution(): TaskGuard {
    return new TaskGuard(false, 1);
  }

  /** Record an executed tool call. One is enough: the guard is
   *  about STARTING the work, not about how the work proceeds. */
  noteToolExecuted(): void {
    this.toolCalls++;
  }

  get continuationsUsed(): number {
    return this.continuations;
  }

  /** Decide what a plain-text (final-answer) model reply means
   *  for this job. Mutates only the continuation counter, and only
   *  on a "continue" verdict. */
  onTextReply(): TaskGuardVerdict {
    if (!this.active || this.toolCalls > 0) return "finalize";
    if (this.continuations < TASK_GUARD_MAX_CONTINUATIONS) {
      this.continuations++;
      return "continue";
    }
    return "exhausted";
  }

  /** The continuation prompt served after a prose reply on a task
   *  job that has not called a tool yet. The model is stateless
   *  across hops, so — like the TOOL_RESULT continuation — it
   *  carries the operator's original request. The skeleton is the
   *  TOOL_PROTOCOL reply shape verbatim, plus one concrete
   *  example in the same shape. */
  continuationPrompt(originalRequest: string): string {
    return (
      "You have not called any tool yet, and this job is a task to carry out with tools — " +
        "a plain-text reply cannot finish it. Reply with ONLY a JSON tool call, in exactly this shape:\n" +
        '{"tool": "<tool name>", "args": { ... }}\n' +
        "For example, to run a shell command:\n" +
        '{"tool": "mac.shell.run", "args": {"command": "git status", "cwd": "/absolute/dir"}}\n' +
        `(The operator's original request was: "${originalRequest}". Begin it now with a tool call.)`
    );
  }
}

/** The `job_update` note the runtime sends when the guard
 *  exhausts. The control plane matches the shared prefix and puts
 *  the remainder on the job's record as the failure cause. */
export function taskGuardExhaustedNote(): string {
  return `${TASK_GUARD_EXHAUSTED_NOTE_PREFIX} no tool calls after ${TASK_GUARD_MAX_CONTINUATIONS} continuations`;
}

/** The runtime's final text when the guard exhausts — the control
 *  plane delivers it to the operator (after egress screening)
 *  alongside the failed-loudly settlement, so the operator hears
 *  what actually happened instead of a verification template. */
export function taskGuardExhaustedFinalText(): string {
  return (
    `I couldn't complete that: this was a task job, but I never called a tool — ` +
    `I answered in plain text instead of starting the work, and ${TASK_GUARD_MAX_CONTINUATIONS} reminders didn't change that.`
  );
}
