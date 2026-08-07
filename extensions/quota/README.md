# Subscription Quota Status

Shows exact remaining subscription quota for OpenAI Codex and Kimi Code in Pi's footer.

```text
Codex 5h 62% · wk 79% | Kimi 5h 88% · wk 74%
```

Percentages are **remaining**, not used.

## Commands

- `/quota` — show quota windows, reset countdowns, freshness, and any sanitized provider error.
- `/quota refresh` — refresh configured providers before showing details.

## Data sources

- OpenAI Codex: `https://chatgpt.com/backend-api/wham/usage` and `x-codex-*` response headers.
- Kimi Code: `https://api.kimi.com/coding/v1/usages`.

Credentials are resolved through Pi's model registry. The extension does not read `auth.json` directly and does not persist, log, or render access tokens or account IDs.

OpenCode Go is intentionally unsupported because it currently has no public quota endpoint. Exact third-party integrations scrape the authenticated workspace dashboard with a browser session cookie.

## Refresh behavior

- Fetch once when a TUI session starts.
- Refresh every five minutes.
- Update Codex immediately when its response headers include quota data.
- Refresh Kimi after a completed Kimi agent run, with a short cooldown and coalescing.

A trailing `~` means the displayed value is the last successful result and the latest refresh failed. `?` means credentials were found but no valid quota window is available yet.
