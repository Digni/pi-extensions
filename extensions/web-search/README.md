# Web Search Extension

DuckDuckGo-powered web access for Pi without MCP.

## Tools

### `web_search`

Searches DuckDuckGo with native `fetch` against DuckDuckGo's HTML endpoint and returns titles, URLs, and snippets. If native search fails, it falls back to [`ddgr`](https://github.com/jarun/ddgr) and then `uvx ddgr`.

Parameters:

- `query` — search query.
- `numResults` — optional, clamped to 1-10, default 5.
- `region` — optional DuckDuckGo region such as `us-en` or `de-de`.
- `time` — optional `d`, `w`, `m`, or `y`.
- `site` — optional site/domain filter.

The native path has no external binary dependency. `ddgr` remains a fallback for rate limits, markup changes, or challenge/consent responses.

### `fetch_content`

Fetches an HTTP(S) URL and extracts readable text locally.

Parameters:

- `url` — HTTP or HTTPS URL.
- `maxChars` — optional, clamped to 1,000-50,000, default 20,000.

The extractor is intentionally simple: it strips scripts/styles/tags, decodes common HTML entities, normalizes whitespace, and truncates output. It blocks local/private-network URL literals by default, validates redirects before following them, and caps raw response size. It does not use hosted reader services, browser automation, cookies, or MCP.

## Setup

No setup is required for the native DuckDuckGo HTML path.

Optional fallback:

```bash
brew install ddgr
# or, if uvx is available:
uvx ddgr --json --num 5 "example query"
```

## Caveats

DuckDuckGo access is unofficial. Searches can fail if DuckDuckGo rate-limits, serves a challenge, or changes markup. For JavaScript-heavy pages, `fetch_content` may return sparse content because it does not run a browser.
