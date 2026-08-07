# Subscription Quota Status Extension Plan

## User decisions

- Add a compact Pi footer status for exact subscription quota remaining.
- Support OpenAI Codex and Kimi Code.
- Use `/quota` for details and manual refresh.
- Leave OpenCode Go out: current official issues confirm there is no public quota endpoint; exact tools scrape `/workspace/:id/go` with a browser session cookie, which the user does not want.
- Display percentages as **remaining**, not used.

## Risk classification

**High risk.** The extension resolves existing provider credentials and sends them to provider-owned quota endpoints. It must never persist, log, render, or include credentials in errors. It also adds polling and asynchronous session-lifecycle behavior.

## Verified context and change boundary

- `package.json` auto-discovers `./extensions`, so `extensions/quota/index.ts` is sufficient for loading.
- Existing extensions use `ctx.ui.setStatus(key, text)` from `session_start` and guard UI work with `ctx.hasUI` (`extensions/auto-compact/index.ts`, `extensions/goal/index.ts`). Pi’s documented cleanup pattern clears keyed status on `session_shutdown` (`examples/extensions/system-prompt-header.ts`).
- Pi documents that timers/network resources must start no earlier than `session_start` and be closed on `session_shutdown`; session replacement reloads extension instances and makes captured old contexts stale (`docs/extensions.md`).
- `AfterProviderResponseEvent` exposes only normalized `status` and `headers`, with no provider identifier (`dist/core/extensions/types.d.ts`). We will therefore consume only the provider-specific `x-codex-*` family and will not infer attribution from the currently selected model.
- Both the project-local Pi 0.79.6 test dependency and the active global Pi 0.84.1 expose `ctx.modelRegistry.getApiKeyForProvider(provider)`. The newer `getProviderAuth()` is not available in 0.79.6, so the implementation uses the older stable method for compatibility.
- OpenAI Codex quota is available from `GET https://chatgpt.com/backend-api/wham/usage`; Codex responses additionally expose `x-codex-primary-*` and `x-codex-secondary-*` usage headers. The usage request needs the resolved OAuth bearer token and, when available, the `chatgpt_account_id` claim from that token as `ChatGPT-Account-Id`.
- Kimi Code quota is available from `GET https://api.kimi.com/coding/v1/usages`; the response supplies a weekly `usage` object and rolling-window entries in `limits[]`.
- The current branch already contains unrelated user changes to `README.md`, deleted `extensions/lsp/*`, and safety-gate files. Implementation will not alter or revert those changes; the quota bullet will be added alongside the user’s README edit.
- Baseline `npm test` passes: 45/45 tests.

## Scope

### Add `extensions/quota/index.ts`

The extension will:

1. Keep quota state only in memory; no credentials or quota data are persisted.
2. Resolve `openai-codex` and `kimi-coding` credentials through `ctx.modelRegistry.getApiKeyForProvider()`.
3. Fetch both provider quota endpoints in parallel on TUI session start and every five minutes.
4. Refresh Kimi after a completed Kimi agent run, with request coalescing/cooldown; update Codex immediately from valid `x-codex-*` response headers. Implementation uses the typed `agent_end` event so this behavior works across the project-local Pi 0.79.6 and current Pi runtimes.
5. Register `/quota`:
   - `/quota` shows detailed remaining percentages, reset times, freshness, and provider errors without exposing response bodies or credentials.
   - `/quota refresh` forces a coalesced refresh before showing details.
6. Set one compact keyed footer status, for example:
   `Codex 5h 62% · wk 79% | Kimi 5h 88% · wk 74%`
7. Omit unconfigured providers. Show `?` for a configured provider with no valid result. Preserve last-known-good values on failures and mark them stale with `~` rather than reporting a fabricated zero.
8. Clear the interval, abort in-flight requests, invalidate the session generation, and clear the status on shutdown.

### Parsing and safety rules

- Convert provider-reported used percentages to remaining percentages and clamp only valid finite values to 0–100.
- Accept finite numeric strings where upstream payloads use them, but treat missing/malformed fields as unavailable rather than zero.
- Prefer provider reset timestamps; otherwise derive from valid positive reset-after seconds.
- Recognize Codex windows by reported duration (5 hours / 7 days) and Kimi rolling windows by duration/time unit; retain only the compact 5-hour and weekly windows.
- Bound each quota request with a 10-second timeout and never retry automatically inside a refresh cycle.
- Do not include authentication values, account IDs, raw provider response bodies, or full thrown objects in statuses/notifications.
- Use a session generation plus per-provider request start time so a late poll cannot overwrite a newer response-header update or a replacement session.

## Consumers and blast radius

### Direct consumers

- Pi TUI footer through the new `quota` status key.
- `/quota` command users.
- Provider quota endpoints, using credentials already managed by Pi.

### Indirect/shared boundaries

- Pi auth resolution may refresh OAuth credentials; the extension will use the public registry API rather than reading `auth.json`.
- Pi lifecycle replacement (`/reload`, `/new`, `/resume`, `/fork`) can invalidate contexts while fetches are active.
- `after_provider_response` runs for all providers, so parsing must require the exact Codex header family.

### Persistence, rollout, rollback, compatibility

- No new persisted state or config file.
- Rollout is automatic through package extension discovery.
- Rollback is deletion of `extensions/quota/`, its tests, and its README entry.
- Source will type-check against the project’s Pi 0.79.6 surface and runtime-smoke against global Pi 0.84.1.

## Implementation chunks and verification dispositions

### Chunk 1 — Pure quota parsing and formatting (TDD)

- RED: Add fixture-based tests for Codex WHAM JSON, Codex response headers, Kimi usage JSON, remaining-percent conversion, reset parsing, malformed/partial values, and compact/detail formatting.
- GREEN: Implement the minimal pure helpers in `extensions/quota/index.ts`.
- **Immediate gate:** `node --test tests/quota-extension.test.mjs`; expected: all new parser/formatter tests pass before lifecycle work begins.
- **Result:** PASS — the focused suite passed after the Codex WHAM, Codex header, and Kimi fixture slices were implemented.

### Chunk 2 — Authenticated fetch and lifecycle integration (TDD)

- RED: Add fake Pi/model-registry/fetch/timer tests covering missing auth, correct endpoint/header construction, 401/429/5xx/malformed responses, last-known-good preservation, request coalescing, stale-result rejection, startup polling, Kimi post-run refresh, and idempotent shutdown abort/status cleanup.
- GREEN: Add provider fetches, `session_start`, `after_provider_response`, `agent_end`, and `session_shutdown` handlers.
- **Immediate gate:** `node --test tests/quota-extension.test.mjs`; expected: all integration/lifecycle tests pass with no unhandled rejections or leaked timers.
- **Result:** PASS — 13/13 focused tests pass, including malformed numeric fields, stale-result ordering, request coalescing, secret-safe failures, the production global-fetch path, five-minute timer cleanup, shutdown abort, and missing-auth behavior.

### Chunk 3 — `/quota`, documentation, and package integration

- Add `/quota` and `/quota refresh` behavior.
- Add `extensions/quota/README.md` documenting sources, freshness, stale marker, security behavior, and the explicit OpenCode Go omission.
- Add a quota bullet to the already-user-modified root `README.md` without changing its other edits.
- **Deferred gate:** the final full suite and type-check below necessarily exercise command registration and package-load syntax; inspect the README diff to ensure only the quota bullet is added.
- **Result:** PASS — command registration, documentation, root README integration, full-suite load, and scoped diff checks all pass.

### Chunk 4 — Review and final verification

- Run the required conservative high-risk `agent-review`, fix actionable findings, then rerun all gates.
- **Immediate gates:**
  1. `npm test`; expected: full repository suite passes.
  2. `npx --yes --package typescript@5.9.3 tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck extensions/quota/index.ts`; expected: type-check passes against project-local Pi 0.79.6.
  3. Runtime smoke with active global Pi 0.84.1: load the extension, run `/quota refresh`, and confirm configured Codex/Kimi values appear while no token/account ID/raw response is rendered. This is a read-only quota check and must not send a model request.
  4. `git diff --check` and scoped diff review; expected: no whitespace errors and no unrelated user changes modified.
- **Results:** PASS — high-risk multi-agent review completed and all validated warnings were fixed; a fresh follow-up review reported no actionable findings. `npm test` passed 58/58, the Pi 0.79.6 type-check passed, `git diff --check` passed, and the live Pi 0.84.1 `/quota refresh` smoke displayed real Codex/Kimi remaining quota and resets with no model request or credential output.

## Credible failure modes

- Provider changes an undocumented quota schema/header. Result: retain last-known-good data, mark stale, and expose a sanitized `/quota` error instead of showing zero.
- OAuth expires during a poll. Result: public Pi auth resolution handles refresh; if it still fails, preserve prior data and do not copy auth errors containing secrets into the UI.
- A request completes after reload/session switch. Result: shutdown abort plus generation checks prevent it from updating the replacement session.
- Multiple triggers overlap. Result: one in-flight refresh per provider; later authoritative header updates win over older polls.

## Pre-mortem

1. **Secret leakage through diagnostics.** Mitigation: never render raw auth, account ID, response bodies, or error objects; tests assert known token fixtures do not appear in statuses/notifications.
2. **Quota status looks exact but is stale.** Mitigation: preserve last-known-good values only with a visible `~`, show freshness/error details in `/quota`, and refresh periodically plus provider-specific post-use triggers.
3. **Background polling survives session replacement.** Mitigation: idempotent shutdown clears timers, aborts active fetches, clears status, and increments a generation checked before every state/UI write.
