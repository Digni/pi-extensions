# Web Search Extension

DuckDuckGo-powered web access for Pi without MCP.

## Tools

### `web_search`

Searches DuckDuckGo through [`ddgr`](https://github.com/jarun/ddgr) and returns titles, URLs, and snippets.

Parameters:

- `query` — search query.
- `numResults` — optional, clamped to 1-10, default 5.
- `region` — optional ddgr region such as `us-en` or `de-de`.
- `time` — optional `d`, `w`, `m`, or `y`.
- `site` — optional site/domain filter.

The extension tries an installed `ddgr` first. If that is missing, it falls back to `uvx ddgr`.

### `fetch_content`

Fetches an HTTP(S) URL and extracts readable text locally.

Parameters:

- `url` — HTTP or HTTPS URL.
- `maxChars` — optional, clamped to 1,000-50,000, default 20,000.

The extractor is intentionally simple: it strips scripts/styles/tags, decodes common HTML entities, normalizes whitespace, and truncates output. It blocks local/private-network URL literals by default, validates redirects before following them, and caps raw response size. It does not use hosted reader services, browser automation, cookies, or MCP.

## Setup

Recommended:

```bash
brew install ddgr
```

Fallback, if `uvx` is available:

```bash
uvx ddgr --json --num 5 "example query"
```

## Caveats

DuckDuckGo access is unofficial. Searches can fail if DuckDuckGo rate-limits, serves a challenge, or changes markup. For JavaScript-heavy pages, `fetch_content` may return sparse content because it does not run a browser.
