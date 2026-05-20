# Goal Extension Async Subagent Wait Fix Plan

## Problem

The `/goal` extension currently increments `turnsUsed` and queues another follow-up on every active-goal `agent_end`. In the observed session, this happened in two related cases: after the orchestrator launched a detached async subagent and had nothing useful to do until completion, and after the orchestrator merely polled a still-running async subagent. Both burn the safety budget without meaningful progress.

## Verified context

- `extensions/goal/index.ts` lines 93-95 build continuation prompts using `state.turnsUsed` as the displayed progress turn.
- `extensions/goal/index.ts` lines 273-296 handle `agent_end`; lines 287-292 increment `turnsUsed`, persist it, then send the next follow-up without inspecting what happened during the just-finished agent run.
- `extensions/goal/index.ts` lines 281-285 already skip continuation when `ctx.hasPendingMessages()` is unavailable, throws, or reports pending messages; this is the existing guard pattern to extend rather than replace.
- `tests/goal-extension.test.mjs` lines 192-208 assert the current active-goal `agent_end` follow-up behavior, and lines 210-228 assert inactive/pending-message skips.
- Pi docs `docs/extensions.md` agent events section says `agent_end` receives `event.messages` from the prompt, so the goal extension can inspect the just-finished run instead of relying only on global session state.
- Pi docs `docs/session-format.md` lines 93-100 define `ToolResultMessage` with `toolName`, `content`, `details`, and `isError` fields; this is enough for a conservative detector in tests.
- The pi-subagents tool describes status checks as `subagent({ action: "status", ... })` in `pi-subagents/src/extension/index.ts` lines 425-428.
- pi-subagents async launch results explicitly say `The async run is detached... If you have nothing else to do until the async result arrives, end your turn now; Pi will deliver the completion when the run finishes` in observed session entries and in the tool behavior shown by `pi-subagents/src/extension/index.ts` rendering/execution paths. These launch results are `toolName: "subagent"` tool results.
- pi-subagents status results format running async runs with text lines including `State: running` in `pi-subagents/src/runs/background/run-status.ts` lines 131-163, and foreground running status also emits `State: running` in `pi-subagents/src/runs/foreground/subagent-executor.ts` lines 199-209.
- I inspected the affected VetZ session file directly: after a running status result, `turnsUsed` advanced at entries equivalent to lines 323-325, 332-334, 343-345, and 352-354; after a detached async launch result, it advanced at entries equivalent to lines 328-330 and 348-350. So a status-only guard alone would prevent repeated polling turns but would still allow the first redundant continuation immediately after launching async work.
- Existing project tests run with `npm test` from `package.json`; I ran `npm test` and all 25 tests passed before this change.
- Validation after review: `@earendil-works/pi-agent-core/dist/agent-loop.js` pushes tool results into `newMessages` before emitting `agent_end` (lines 115-124 and 148-166), and `@earendil-works/pi-coding-agent/dist/core/agent-session.js` forwards `event.messages` unchanged to extension `agent_end` handlers (lines 400-401). So inspecting `event.messages` is a real, supported path, not just documentation.
- Validation after review: actual affected session entries include mixed real-work/status turns, e.g. a running `subagent` status and a `bash` result in the same run before `turnsUsed` advanced. This means the test suite should explicitly lock in the chosen policy: any waiting async subagent result suppresses continuation, even if other tool results exist in the same run.
- Validation after review: pi-subagents completion and attention notices are custom messages with `triggerTurn` (`runs/background/notify.ts` lines 97-104; `extension/control-notices.ts` lines 44-55), so keeping the goal active should allow notifications to wake the orchestrator without `/goal` polling.

## Proposed behavior

When a goal is active and `agent_end` fires:

1. Keep the current inactive, max-turns, and pending-message guards.
2. Before incrementing `turnsUsed`, inspect `event.messages` for non-error `toolResult` messages from `toolName === "subagent"`.
3. Suppress goal auto-continuation when any such subagent result indicates the orchestrator is waiting on async work:
   - running status output (`State: running`), or
   - detached async launch output (`The async run is detached` / `Pi will deliver the completion when the run finishes`).
4. When suppressed, do **not** increment `turnsUsed` and do **not** queue another goal follow-up. Notify the user that `/goal` is waiting for the running/detached subagent instead of spending a continuation turn.
5. Leave the goal status as `active`, not `paused`, because async subagent completion/attention notifications can later trigger a normal agent turn and the user can also resume/continue manually.
6. Add a short sentence to continuation prompts telling the orchestrator not to repeatedly poll running async subagents; it should wait for completion/needs-attention notifications or user input.

This fixes both the immediate post-launch redundant continuation and the repeated status-poll continuation without changing the public state shape or requiring a hard dependency on pi-subagents internals.

## TDD implementation chunks

### Chunk 1 — Red tests for async subagent waiting

1. Add a failing test in `tests/goal-extension.test.mjs` that calls the registered `agent_end` hook with an `event.messages` array containing a `toolResult` for `toolName: "subagent"` and text `State: running`.
2. Add a failing test for a detached async launch result containing `The async run is detached` and `Pi will deliver the completion when the run finishes`.
3. Add a failing mixed-results test with both a successful `bash` tool result and a running `subagent` status; expected policy is still suppression to avoid polling/budget burn while async work is outstanding.
4. In these tests, assert that no new `goal-state` entry is appended, no follow-up user message is sent, and a notification mentions waiting/running subagent.
5. Verification checkpoint: run `npm test`; expect the new tests to fail because current `agent_end` increments and sends a continuation.

### Chunk 2 — Conservative detector and guard

1. Implement small helpers in `extensions/goal/index.ts`:
   - extract text from string or text-content arrays,
   - identify non-error `subagent` tool results,
   - detect `State: running` with a line-oriented, case-insensitive regex,
   - detect detached async launch guidance with conservative substrings from the verified pi-subagents output.
2. Call the detector in `agent_end` after the pending-message guard and before incrementing `turnsUsed`.
3. Verification checkpoint: run `npm test`; expect all tests to pass.

### Chunk 3 — Prompt guidance regression

1. Update `continuationPrompt` to include the async-wait guidance.
2. Extend an existing assertion to verify continuation prompts include the new guidance.
3. Verification checkpoint: run `npm test`; expect all tests to pass.

## Edge cases and failure modes

- `event.messages` missing, null, or not an array: detector returns false; existing continuation behavior remains unchanged.
- Tool result content is not a text array/string: ignore it and continue unchanged.
- `subagent` status result is an error: ignore it; errors may require another orchestrator turn or user-visible handling.
- Running status or detached-launch text changes upstream: detector may miss it and old behavior returns. The matching is intentionally tied to currently verified pi-subagents output rather than guessing hidden fields.
- A completed/failed/paused subagent status appears: do not suppress continuation; the orchestrator may need the next goal turn to verify/apply results.
- A running/detached subagent appears alongside other meaningful work in the same `agent_end`: the guard will still suppress the immediate continuation. This favors avoiding budget burn and polling loops over aggressively continuing while a background worker is still active, and is backed by an explicit mixed-results regression test.
- A subagent never completes and no completion/attention notification arrives: the goal can remain active with a frozen turn count. This is safer than the current polling loop, but it means the user may need to intervene manually. A consecutive-suppression failsafe can be added later if this becomes noisy; it is not required to stop the observed budget burn because suppression sends no follow-up.
- `ctx.ui.notify` unavailable (`hasUI` false): `notify()` already no-ops when no UI exists, so behavior is still safe.

## Blast radius

- Changes only `extensions/goal/index.ts` and `tests/goal-extension.test.mjs`.
- No persisted state schema change; existing `goal-state` entries remain valid.
- Does not alter pi-subagents code or require importing it.
- Shared Pi APIs touched: only `agent_end` event handling and user notification, already used by the goal extension.

## Pre-mortem

1. The plan failed because `agent_end.event.messages` does not include tool results in some Pi modes. Mitigation: detector treats missing messages as false, so it cannot break continuation, but the bug could persist in those modes.
2. The plan failed because pi-subagents changes status/detached wording. Mitigation: keep detector small and test-driven; if upstream changes, add a new verified text/shape check rather than broad fuzzy matching.
3. The plan failed because suppressing continuation while a subagent is running leaves the active goal idle forever if no completion notification triggers a turn. Mitigation: keep goal active and notify; pi-subagents verified completion notifications use `pi.sendMessage(..., { triggerTurn: true })`, and the user can still manually prompt or `/goal resume`.

## Planning Verification

- [x] Every file/line reference was read directly by me (not from subagent summary alone)
- [x] I ran diagnostic commands myself for facts in the plan (`grep`, `find`, `nl`, `npm test`)
- [x] Each step has a verification checkpoint with concrete command and expected outcome
- [x] I searched for existing patterns before proposing new ones
- [x] I checked current filesystem state for counts, paths, and names (`plans/` contents and relevant files)
- [x] Blast radius listed if shared code is touched (all usages traced)
- [x] Edge cases documented for every integration point and data transformation
