/**
 * The task guard's decision surface (v0.14.3) — a pure unit
 * surface, pinned:
 *
 *  - Only kind "task" activates the guard. Every other kind —
 *    and a loop entered after a tool already executed — gets a
 *    guard whose every verdict is "finalize": the pre-guard loop.
 *  - An active guard with zero tool calls serves exactly
 *    TASK_GUARD_MAX_CONTINUATIONS "continue" verdicts, then
 *    "exhausted" — never a third continuation, never a finalize.
 *  - One executed tool call disengages the guard permanently:
 *    every later prose reply finalizes, however many
 *    continuations were already spent.
 *  - The continuation prompt carries the no-tool-yet instruction,
 *    the TOOL_PROTOCOL JSON skeleton verbatim, one concrete
 *    example, and the operator's original request (the model is
 *    stateless across hops).
 *  - The exhaustion note and final text name the cause and the
 *    continuation count — the operator never hears a generic
 *    verification failure for a job that did no work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_GUARD_EXHAUSTED_NOTE_PREFIX } from "../../packages/shared/src/index.js";
import {
  TaskGuard,
  TASK_GUARD_MAX_CONTINUATIONS,
  taskGuardExhaustedFinalText,
  taskGuardExhaustedNote,
} from "../../packages/runtime/src/task-guard.js";

test("task guard: only kind 'task' activates the guard", () => {
  assert.equal(TaskGuard.forJob("task").active, true);
  for (const kind of ["chat", "canary", "digest", "fetch-summarize", "workspace-file", "reminder", "update", ""]) {
    assert.equal(TaskGuard.forJob(kind).active, false, `kind ${kind || "(empty)"} must not activate the guard`);
  }
});

test("task guard: an inactive guard finalizes every prose reply, forever", () => {
  const guard = TaskGuard.forJob("chat");
  for (let i = 0; i < 5; i++) assert.equal(guard.onTextReply(), "finalize");
  assert.equal(guard.continuationsUsed, 0, "an inactive guard never spends a continuation");
});

test("task guard: a loop entered after a tool executed finalizes immediately", () => {
  const guard = TaskGuard.afterToolExecution();
  assert.equal(guard.onTextReply(), "finalize");
  assert.equal(guard.continuationsUsed, 0);
});

test("task guard: prose with zero tool calls earns exactly N continuations, then exhaustion", () => {
  const guard = TaskGuard.forJob("task");
  assert.equal(TASK_GUARD_MAX_CONTINUATIONS, 2, "the bound the brief and the panel agreed");
  assert.equal(guard.onTextReply(), "continue");
  assert.equal(guard.continuationsUsed, 1);
  assert.equal(guard.onTextReply(), "continue");
  assert.equal(guard.continuationsUsed, 2);
  assert.equal(guard.onTextReply(), "exhausted", "no third continuation, and never a finalize");
  assert.equal(guard.onTextReply(), "exhausted", "exhaustion is stable — the loop must stop, not drift");
  assert.equal(guard.continuationsUsed, 2);
});

test("task guard: one executed tool call disengages the guard permanently", () => {
  const guard = TaskGuard.forJob("task");
  assert.equal(guard.onTextReply(), "continue", "prose before any tool: continued");
  guard.noteToolExecuted();
  assert.equal(guard.onTextReply(), "finalize", "after a tool ran, prose is a normal final answer");
  assert.equal(guard.onTextReply(), "finalize");
});

test("task guard: a tool call before any prose reply means the guard never engages", () => {
  const guard = TaskGuard.forJob("task");
  guard.noteToolExecuted();
  assert.equal(guard.onTextReply(), "finalize");
  assert.equal(guard.continuationsUsed, 0);
});

test("task guard: the continuation prompt carries the instruction, the skeleton, and the request", () => {
  const guard = TaskGuard.forJob("task");
  const prompt = guard.continuationPrompt("build the release and attach the DMG");
  assert.ok(prompt.includes("You have not called any tool yet"), "the no-tool-yet instruction leads");
  assert.ok(prompt.includes("this job is a task to carry out with tools"), "it says why prose cannot finish");
  assert.ok(
    prompt.includes('{"tool": "<tool name>", "args": { ... }}'),
    "the TOOL_PROTOCOL skeleton rides verbatim — the model can copy the syntax",
  );
  assert.ok(
    prompt.includes('{"tool": "mac.shell.run", "args": {"command": "git status", "cwd": "/absolute/dir"}}'),
    "one concrete example in the same shape",
  );
  assert.ok(
    prompt.includes('The operator\'s original request was: "build the release and attach the DMG"'),
    "the stateless model is reminded what it is in the middle of doing",
  );
});

test("task guard: the exhaustion note and final text name the cause and the count", () => {
  const note = taskGuardExhaustedNote();
  assert.ok(note.startsWith(TASK_GUARD_EXHAUSTED_NOTE_PREFIX), "the host matches the shared prefix");
  assert.ok(note.includes("no tool calls after 2 continuations"), "the cause the job record will carry");
  const text = taskGuardExhaustedFinalText();
  assert.ok(text.includes("never called a tool"), "the operator hears the real reason");
  assert.ok(text.includes("2 reminders"), "and how many chances the model had");
});
