# Auto Compact

Global pi extension that triggers compaction after the current prompt finishes when context usage crosses a configurable percentage of the active model's context window.

Default global config: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/auto-compact/config.json`

```json
{
  "enabled": true,
  "thresholdPercent": 70,
  "customInstructions": ""
}
```

## Commands

- `/auto-compact` or `/auto-compact status` — show status.
- `/auto-compact 70` — set threshold for the current session.
- `/auto-compact global 70` — persist threshold globally.
- `/auto-compact on` / `/auto-compact off` — enable/disable for current session.
- `/auto-compact now [instructions]` — compact immediately.

Session changes are stored in the current session JSONL via `pi.appendEntry()` and survive resuming that session. Global config applies to all sessions unless a session override exists.
