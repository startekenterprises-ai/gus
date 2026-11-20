/**
 * The voice fast lane (v0.9.8) — the runtime half.
 *
 * A live voice call's spoken chat turn shouldn't pay the full
 * chat-job cost: on the 2026-11-12 field call, trivial greetings
 * took 8–16 s of model time because a voice job ran the identical
 * unbounded loop as a typed research request. Jobs the control
 * plane stamps `voiceFastLane` (a live call's plain-chat turn —
 * the stamp is on the job record, never inferred from text) get a
 * steered shape here:
 *
 *   - the primary model call runs exactly as any job's does;
 *   - if it asks for a tool, the tool executes exactly as any
 *     job's does (same authorization, same Shield surfaces) and
 *     the ONE continuation carries VOICE_FAST_LANE_FINAL_NOTE:
 *     answer now, in plain text — this is the final model call
 *     for the spoken reply;
 *   - if the model STILL asks for a tool after that, the job has
 *     left the lane: the tool executes and the loop continues
 *     unbounded, with no further notes. A legitimately tool-using
 *     request is never broken by the lane — it just takes the
 *     slower path, as designed.
 *
 * Why steering instead of a hard cut: the ChannelHost settles a
 * job verified-done only when the delivered text's hash matches
 * Governor-issued model output, so the loop may not end a job on
 * runtime-composed text — a hard hop cap would strand tool-using
 * turns in a failed-loudly settle for doing nothing wrong. The
 * Governor's caps remain the only spend brake (MAX_HOPS stays a
 * liveness backstop); the lane shapes the common case — a spoken
 * question, at most one tool, a short spoken answer — and the
 * control plane's reply-token clamp (VOICE_REPLY_TOKEN_BUDGET)
 * bounds each call's cost. Approvals, the kill phrase, and the
 * Shield ingress scan are untouched: they live in the control
 * plane and the voice channel, upstream of this loop.
 */

export const VOICE_FAST_LANE_FINAL_NOTE =
  "\n(Voice call fast lane: this is the final model call for this spoken reply — " +
  "answer now in plain text, with no tool calls. The reply is read aloud, so keep it to a few sentences.)";

/** Per-turn lane state: how many tool-result continuations this
 *  job has already been served. Inactive for every non-voice job,
 *  in which case every method is a pass-through. */
export class VoiceLane {
  private continuations = 0;

  constructor(readonly active: boolean) {}

  /** True while the job is still in the steered shape: the lane
   *  is on and at most the one noted continuation has been served. */
  get inLane(): boolean {
    return this.active && this.continuations <= 1;
  }

  /** Build the prompt for the model call that follows a tool
   *  result. The FIRST continuation of a fast-lane job carries the
   *  final-call note; later continuations (the job promoted itself
   *  out of the lane by asking for another tool) carry the plain
   *  continuation, byte-identical to a non-voice job's. */
  continuationPrompt(base: string): string {
    if (!this.active) return base;
    this.continuations += 1;
    return this.continuations === 1 ? base + VOICE_FAST_LANE_FINAL_NOTE : base;
  }
}
