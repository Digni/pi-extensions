# Goal Extension Implementation Plan

## User decisions

- `/goal <objective>` should auto-continue with a safety cap until the agent marks the goal complete or the cap is reached.
- First version should be Codex-like: `/goal <objective>`, `/goal status`, `/goal clear`, `/goal pause`, `/goal resume`, `/goal complete`, plus agent-callable completion/status tools.

## Verified context

- This package auto-discovers every extension under `./extensions` via `package.json` lines 11-12, so a new `extensions/goal/index.ts` fits the current package shape.
- The README extension list is maintained manually at `README.md` lines 11-16 and should be updated.
- Existing tests use Node's built-in test runner via `package.json` line 8 and dynamically import extension `index.ts` modules through a fake Pi API (`tests/safety-gate-auto-model.test.mjs` lines 25-38), so the goal extension should get a matching behavior-level test file.
- Existing extensions persist session state with `pi.appendEntry`: `auto-compact` uses `STATE_ENTRY` and reconstructs from session entries at `extensions/auto-compact/index.ts` lines 32 and 166-185; `safety-gate` persists at lines 552-553 and reloads at lines 565-585.
- Existing extensions expose slash commands with `pi.registerCommand`, e.g. `safety-gate` at lines 600-728.
- Pi extension docs confirm custom extensions can register commands/tools (`docs/extensions.md` lines 55-80 and 1372-1385), send user messages that trigger turns (`docs/extensions.md` lines 1291-1315), persist non-context state with `appendEntry` (`docs/extensions.md` lines 1319-1325), and add steering/custom messages with delivery modes (`docs/extensions.md` lines 1268-1289).
- Codex's goal implementation uses explicit goal tools named `get_goal`, `create_goal`, and `update_goal` (`codex-rs/ext/goal/src/spec.rs` lines 9-11). Its create tool says goals should only be created when explicitly requested and rejects creating a second goal (`spec.rs` lines 25-56). Its update tool only allows marking a goal complete and warns not to mark complete merely because stopping or budget is exhausted (`spec.rs` lines 59-88). Codex also models continuation/accounting as lifecycle work and notes that active goals need idle/next-turn wake capability (`codex-rs/ext/goal/src/extension.rs` lines 157-185).

## Proposed behavior

### Slash command

Create `extensions/goal/index.ts` registering `/goal`.

Supported forms:

- `/goal <objective>`: set or replace the active session goal, reset continuation counters, persist state, update status, and immediately send a kickoff user message.
- `/goal status` or bare `/goal`: display current goal state and command hints.
- `/goal pause`: mark paused; no auto-continuation while paused.
- `/goal resume`: mark active and send a continuation message if idle.
- `/goal complete`: mark complete manually.
- `/goal clear`: remove the goal from active state.

If an active/paused goal already exists and the user sets a new objective, confirm replacement when `ctx.hasUI` is true; without UI, replace deterministically and notify.

### Agent-facing tools

Register two namespaced tools to avoid collisions with future/builtin generic goal tools:

- `goal_status`: returns structured current goal state.
- `goal_complete`: marks the current active goal complete; no params.

The tool descriptions will mirror Codex's important constraints: only complete when the objective is achieved and no required work remains.

### Goal steering and continuation

- Use `before_agent_start` to append goal-specific instructions to the system prompt while a goal is active: objective, current turn count, safety cap, use `goal_complete` when achieved, report blockers instead of looping indefinitely.
- Use `agent_end` to auto-continue only when:
  - status is active,
  - no continuation is already being sent,
  - the goal has not reached the safety cap,
  - no pending messages are present (via `ctx.hasPendingMessages()` when available).
- Auto-continuation will use `pi.sendUserMessage(..., { deliverAs: "followUp" })` while streaming/finishing, or immediate send when idle. If the safety cap is reached, mark the goal paused with a reason and notify rather than sending more turns.
- Default safety cap: 8 continuation turns. Add `/goal max <n>` is intentionally deferred unless implementation reveals it is necessary; the first version will keep the cap as a constant and show it in status.

### State model

Persist state as append-only custom entries with custom type `goal-state`:

```ts
type GoalState = {
  objective?: string;
  status: "active" | "paused" | "complete" | "cleared";
  createdAt?: number;
  updatedAt: number;
  turnsUsed: number;
  maxTurns: number;
  lastReason?: string;
};
```

On `session_start`, replay branch entries and pick the latest valid `goal-state`, matching the pattern used by existing extensions.

## TDD implementation chunks

### Chunk 1 — Command registration and state persistence

1. RED: Add `tests/goal-extension.test.mjs` with a fake Pi API asserting `/goal write docs` appends `goal-state`, sets footer status, notifies/kicks off, and reconstructs state after a simulated `session_start`.
2. GREEN: Create `extensions/goal/index.ts` with minimal command parsing, state persistence, session reconstruction, status updates, and kickoff message.
3. Verification checkpoint: `npm test` passes, including the new test.

### Chunk 2 — Controls and replacement behavior

1. RED: Add tests for `/goal pause`, `/goal resume`, `/goal complete`, `/goal clear`, and replacement confirmation when UI exists.
2. GREEN: Implement control commands and replacement confirmation.
3. Verification checkpoint: `npm test` passes; manual inspect of notifications/status text confirms command hints are useful.

### Chunk 3 — Agent tools and prompt steering

1. RED: Add tests that `goal_status` returns structured state and `goal_complete` marks complete; add a test that `before_agent_start` injects goal instructions only for active goals.
2. GREEN: Register tools and `before_agent_start` handler.
3. Verification checkpoint: `npm test` passes; verify registered tool names do not collide with existing project tools via `grep -R "name: \"goal_" extensions tests`.

### Chunk 4 — Bounded auto-continuation

1. RED: Add tests that `agent_end` sends a follow-up while active, does not send when paused/complete/cleared, and pauses at the cap.
2. GREEN: Implement guarded continuation with an in-flight flag and pending-message check.
3. Verification checkpoint: `npm test` passes; run `pi -e ./extensions/goal/index.ts --mode json -p "/goal test goal extension status output"` only if the local Pi CLI accepts extension commands in print/json mode; otherwise document why skipped.

### Chunk 5 — Documentation

1. Update `README.md` extension list and add `extensions/goal/README.md` with usage, safety cap behavior, and command list.
2. Verification checkpoint: `npm test` passes and `grep -R "goal" README.md extensions/goal/README.md` shows documented commands.

## Edge cases and failure modes

- Empty `/goal <objective>`: show usage; do not mutate state.
- Existing goal replacement: confirm with UI; without UI replace deterministically to avoid hanging a non-interactive command.
- `pi.sendUserMessage` throws because the agent is busy or mode does not allow sending: catch, mark goal paused with `lastReason`, notify error.
- `ctx.hasPendingMessages()` missing or throws: treat as pending/unsafe and skip continuation for that `agent_end`.
- Tool called with no active goal: return text explaining there is no active goal; do not throw unless schema validation fails.
- `goal_complete` called while paused/cleared: return a no-op message; do not reactivate.
- Session replay sees malformed custom entries: ignore invalid shapes and fall back to no goal.
- Safety cap reached: pause instead of completing; the agent must not mark success solely because the cap was reached (mirrors Codex completion guidance).

## Blast radius

- Adds a new extension directory under `extensions/goal`; no shared extension code changes expected.
- Updates README only.
- Adds tests under `tests/`; existing `npm test` suite should continue to pass.
- Uses generic Pi APIs (`registerCommand`, `registerTool`, `before_agent_start`, `agent_end`, `appendEntry`, `sendUserMessage`) and should not affect other extensions except for additional active tools/status rows.

## Pre-mortem

1. Auto-continuation loops uncontrollably because the extension sends a new prompt after every `agent_end`. Mitigation: explicit `maxTurns`, in-flight flag, status checks, and pending-message guard in Chunk 4.
2. The agent never knows how to stop. Mitigation: active-goal system prompt injection and a dedicated `goal_complete` tool whose guidance mirrors Codex's `update_goal` constraints.
3. Session state gets out of sync after reload/branch navigation. Mitigation: append-only `goal-state` entries and replay on `session_start`, matching existing project patterns.

## Planning Verification

- [x] Every file/line reference was read directly by me (not from subagent summary alone)
- [x] I ran diagnostic commands myself for facts in the plan (`npm test`, `find`, `grep`, `nl`)
- [x] Each step has a verification checkpoint with concrete command and expected outcome
- [x] I searched for existing patterns before proposing new ones
- [x] I checked current filesystem state for counts, paths, and names
- [x] Blast radius listed if shared code is touched (all usages traced)
- [x] Edge cases documented for every integration point and data transformation
