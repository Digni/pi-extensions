# Goal Extension

Persistent session goals for Pi.

## Usage

```text
/goal <objective>   Set or replace the active goal and start working
/goal               Show current goal status
/goal status        Show current goal status
/goal pause         Pause auto-continuation
/goal resume        Resume and continue the goal
/goal complete      Mark the goal complete manually
/goal clear         Clear the goal
```

When active, the extension injects the goal into the agent's system prompt and auto-sends bounded follow-up turns. The default cap is 8 continuation turns. If the cap is reached, the goal is paused rather than marked complete.

## Agent tools

- `goal_status` — returns the current goal state.
- `goal_complete` — marks the goal complete. The agent is instructed to call this only when the objective is actually achieved and no required work remains.

Goal state is stored in the Pi session as append-only `goal-state` entries, so it survives reloads and follows the active session branch.
