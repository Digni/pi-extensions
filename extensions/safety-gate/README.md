# Safety Gate pi Extension

User-global extension: `~/.pi/agent/extensions/safety-gate/index.ts`.

It intercepts dangerous pi tool calls before execution and either asks for confirmation, blocks them, or sends them to a fast isolated pi reviewer for automatic review.

## What it watches

- `bash` tool calls and `!` / `!!` user bash commands
- `write` / `edit` to sensitive paths

Examples of gated operations:

- broad or recursive deletion (`rm -rf`, recursive deletes against `/`, `~`, `..`, root-level directories/wildcards, etc.)
- privilege escalation (`sudo`, `doas`, `su`)
- unsafe permissions/ownership (`chmod 777`, `chmod a+rwx`, `chown`, `chgrp`, especially recursive)
- disk/system operations (`mkfs`, `dd of=/dev/...`, `diskutil erase`, reboot/shutdown)
- remote download piped to shell (`curl ... | sh`)
- writes/edits under `/etc`, system binary dirs, `~/.ssh`, `~/.gnupg`, `.env*`, `.npmrc`

## Modes and config

Built-in default mode is `confirm`, but config files override it. This install has global config at `~/.pi/agent/extensions/safety-gate/config.json` set to `auto`.

Config precedence is:

1. CLI flags (`--safety-mode`, `--safety-review-model`, `--safety-review-fallback-model`)
2. Project config (`.pi/safety-gate.json`, discovered from the current directory up to the git root)
3. Global config (`~/.pi/agent/extensions/safety-gate/config.json`)
4. Session changes made with `/safety <mode>` when no config overrides them
5. Built-in defaults

```text
/safety confirm          Ask before dangerous calls for this session
/safety auto             Use quick isolated pi review for this session
/safety block            Always block dangerous calls for this session
/safety off              Disable the gate for this session
/safety models           Show available auto-review models ranked for safety review
/safety model            Pick/list the session primary reviewer model
/safety model auto       Auto-pick the primary reviewer from available models
/safety fallback         Pick/list the session fallback reviewer model
/safety fallback auto    Auto-pick the fallback reviewer from available models
/safety critical-override on
                         Session-only escape hatch: critical auto-block can be manually overridden
/safety critical-override off
                         Disable the critical auto-block override for this session
/safety global auto      Persist global default mode
/safety project confirm  Persist project mode in .pi/safety-gate.json
/safety status           Show current mode/models, resolved models, override state, and config paths
```

If you run `/safety` with no arguments in the TUI, it opens a session mode selector. The status line stays compact (`🛡️ safety:auto (global)` or `🛡️ safety:auto (global, critical override)`); use `/safety status` to see model details.

## Auto-review models

The built-in primary and fallback reviewer settings are both `auto`. At review time, `auto` is resolved from `ctx.modelRegistry.getAvailable()` and ranked toward fast/cheap model names such as `spark`, `mini`, `flash`, `fast`, `haiku`, `lite`, or `small`. Terms are matched as complete name tokens, so a name such as `minimax` is not treated as `mini`. Within the same fast-name tier, `openai-codex` models are preferred before cost and token-budget tie-breakers.

On pi versions that expose provider-origin metadata, automatic selection excludes providers registered by extensions because the isolated reviewer intentionally runs with `--no-extensions`. Older pi versions retain the available-model list and fail safely through `UNSURE` if the child cannot invoke a selected provider. The primary auto reviewer uses the top-ranked eligible model. The fallback auto reviewer uses the next top-ranked eligible model, or the same model if only one model is eligible. A model that fails operationally, times out, or returns malformed output is excluded from automatic selection for the rest of that pi session.

Safety-gate treats `openai-codex/gpt-5.4-mini` as removed and excludes it from automatic resolution, model listings, and selectors. Existing configuration, session state, and CLI flags naming it are ignored so normal precedence and defaults apply; new configuration commands naming it are rejected. Other explicit model settings remain accepted, and an explicit model that the isolated process cannot invoke fails safely through `UNSURE`.

Auto-review runs reviewers as isolated subprocesses:

```bash
pi --no-extensions --no-context-files --no-skills --no-prompt-templates \
  --system-prompt <fixed-safety-prompt> --model <resolved-model> --thinking off \
  --mode json -p --no-session --no-tools <json-review-input>
```

The child runs from the system temporary directory. It does not load project instructions, extensions, skills, prompt templates, tools, or session history. The tool call is encoded as untrusted JSON data, and only an exact one-line `ALLOW`, `BLOCK`, or `UNSURE` verdict is accepted. Reviewer credentials and network access are still inherited so the selected provider can be called.

The review JSON includes an `initiator` field (`agent` for tool calls, `user` for `!` commands) and an optional `statedIntent` field with the newest agent intent after the latest user message, falling back to that user message. Agent calls also include `recentConversation`: the newest user message and its immediately preceding assistant text from the active session branch. Text fields are truncated to 800 characters.

This gives the reviewer the *why* behind a call and preserves an explicit chat approval such as “yes” together with the exact action and target the assistant asked about. For non-critical agent calls, an exact user request or approval is authoritative only for that action and target; mismatches, refusals, ambiguous exchanges, broad targets, and compound commands with extra operations remain blocked. Assistant text alone cannot authorize a call, and direct `!` commands do not inherit chat approval context. Narrow regenerable targets inside the working directory remain allowable when the stated intent matches. A uniquely named system-temporary directory outside the working directory requires an exact matching user request or approval.

Change models for the current session with:

```text
/safety model auto
/safety fallback auto
/safety model <provider/model-id>
/safety fallback <provider/model-id>
```

Persist model choices globally or per project with:

```text
/safety global model auto
/safety global fallback auto
/safety project model auto
/safety project fallback auto
/safety global model <provider/model-id>
/safety global fallback <provider/model-id>
/safety project model <provider/model-id>
/safety project fallback <provider/model-id>
```

or at startup:

```bash
pi --safety-mode auto \
  --safety-review-model auto \
  --safety-review-fallback-model auto
```

The reviewer is deliberately conservative and runs for `medium` and `high` findings while mode is `auto`. It returns `ALLOW`, `BLOCK`, or `UNSURE`; `UNSURE` after fallback falls back to user confirmation when UI is available and blocks in non-interactive mode.

`critical` is reserved for catastrophic or broad operations: broad recursive deletion targets, filesystem/disk destruction, recursive permission or ownership changes against broad targets, and writes directly to `/` or the user's home directory. Scoped operations such as `rm -rf node_modules`, `chmod -R 777 ./build`, or `chown -R app ./build` are `high` and receive model review.

Critical findings never reach the reviewer and are auto-blocked. If `/safety critical-override on` is enabled for the current session, a critical call can be manually overridden in interactive UI. The override is intentionally two-step: first confirm the critical warning, then type the exact phrase `allow critical`. Non-interactive/headless sessions always block critical calls.

## Startup flags

```bash
pi --safety-mode confirm
pi --safety-mode auto
pi --safety-mode block
pi --safety-mode off
pi --safety-review-model auto
pi --safety-review-fallback-model auto
```

Because this extension is in `~/.pi/agent/extensions/`, pi auto-loads it globally. Use `/reload` in existing sessions after changing the file.
