# Safety Gate pi Extension

User-global extension: `~/.pi/agent/extensions/safety-gate/index.ts`.

It intercepts dangerous pi tool calls before execution and either asks for confirmation, blocks them, or sends them to a fast isolated pi reviewer for automatic review.

## What it watches

- `bash` tool calls and `!` / `!!` user bash commands
- `write` / `edit` to sensitive paths

Examples of gated operations:

- broad or recursive deletion (`rm -rf`, recursive deletes against `/`, `~`, `..`, wildcards, etc.)
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
                         Session-only escape hatch: critical auto-review BLOCK can be manually overridden
/safety critical-override off
                         Disable the critical auto-block override for this session
/safety global auto      Persist global default mode
/safety project confirm  Persist project mode in .pi/safety-gate.json
/safety status           Show current mode/models, resolved models, override state, and config paths
```

If you run `/safety` with no arguments in the TUI, it opens a session mode selector. The status line stays compact (`🛡️ safety:auto (global)` or `🛡️ safety:auto (global, critical override)`); use `/safety status` to see model details.

## Auto-review models

The built-in primary and fallback reviewer settings are both `auto`. At review time, `auto` is resolved from `ctx.modelRegistry.getAvailable()` and ranked toward fast/cheap model names such as `spark`, `mini`, `flash`, `fast`, `haiku`, `lite`, or `small`.

The primary auto reviewer uses the top-ranked available model. The fallback auto reviewer uses the next top-ranked model, or the same model if only one model is available.

Auto-review runs reviewers as isolated subprocesses:

```bash
pi --no-extensions --model <resolved-model> --mode json -p --no-session --no-tools <review-prompt>
```

This matches normal pi model invocation and avoids nested in-process provider oddities. Because the isolated subprocess uses `--no-extensions`, models provided only by extensions may not be available there; that failure becomes `UNSURE` and follows the normal fallback/confirmation behavior.

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

The reviewer is deliberately conservative and runs for any static finding severity (`medium`, `high`, or `critical`) while mode is `auto`. It returns `ALLOW`, `BLOCK`, or `UNSURE`; `UNSURE` after fallback falls back to user confirmation when UI is available and blocks in non-interactive mode.

By default, `BLOCK` means block. If `/safety critical-override on` is enabled for the current session, a `critical` finding with an auto-review `BLOCK` can be manually overridden in interactive UI. The override is intentionally two-step: first confirm the critical warning, then type the exact phrase `allow critical`. Non-interactive/headless sessions still block.

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
