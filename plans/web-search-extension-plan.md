# DuckDuckGo Web Search Extension Plan

## User decisions

- Build a non-MCP web access extension using the DuckDuckGo CLI ecosystem.
- Include both `web_search` and `fetch_content` in the first version.
- Dependency strategy: prefer installed `ddgr`; fall back to `uvx ddgr` when `ddgr` is not installed.
- Fetch strategy: local simple extractor only; no hosted reader service such as Jina.

## Verified context

- The repo auto-discovers extensions from `./extensions` via `package.json` lines 11-12, so a new `extensions/web-search/index.ts` will be loaded with the package.
- The test suite is `node --test tests/*.test.mjs` (`package.json` line 8), and current extension tests dynamically import extension modules with fake Pi APIs (`tests/goal-extension.test.mjs` lines 7-29). The web extension tests should follow that public-interface harness style.
- Existing extension code uses hand-written JSON-schema objects without importing `typebox` in the goal extension (`extensions/goal/index.ts` lines 18-23), avoiding direct runtime dependency issues in Node tests.
- Existing custom tool registration patterns are in `extensions/goal/index.ts` lines 225-264, and Pi docs confirm `pi.registerTool()` plus `promptSnippet`/`promptGuidelines` behavior (`docs/extensions.md` lines 1217-1228).
- Pi docs confirm extensions can execute commands with `pi.exec(command, args, { signal, timeout })` and get stdout/stderr/code (`docs/extensions.md` lines 1474-1481), which is the right integration point for `ddgr`/`uvx`.
- `README.md` lists extensions manually at lines 5-11, so it should be updated.
- There are currently no existing `web_search`, `fetch_content`, `web-search`, or `ddgr` symbols in the repo (`grep` returned no matches), so tool/extension names are available.
- Current extension directories are `auto-compact`, `goal`, `lsp`, `read-guard`, and `safety-gate`; a new `web-search` directory does not collide.
- Local landscape check: `ddgr` is not installed globally, `uvx` is installed, and `uvx ddgr --help` works. Verified `uvx ddgr --json --num 2 "pi coding agent extensions"` returns JSON objects with `title`, `url`, and `abstract`.
- Landscape summary from live checks: `jarun/ddgr` is active and DuckDuckGo-focused; `jarun/googler` is archived; `searxngr` depends on SearXNG instances; `duckduckgo-search`/`ddgs` is a Python library/CLI alternative; Playwright-based tools are heavier.

## Proposed implementation

### Extension placement

Add `extensions/web-search/`:

- `index.ts` — registers tools and helper logic.
- `README.md` — documents setup, tools, caveats, and dependency fallback.

Update root `README.md` extension list with `web-search`.

### `web_search` tool

Parameters:

```ts
{
  query: string;              // required unless future batch support is added
  numResults?: number;        // clamp 1..10, ddgr supports up to 25 but keep context small
  region?: string;            // optional ddgr -r value
  time?: "d" | "w" | "m" | "y"; // optional ddgr -t value
  site?: string;              // optional ddgr -w value
}
```

Execution:

1. Normalize and validate query. Empty query throws a tool error.
2. Try `pi.exec("ddgr", args, { signal, timeout: 30000 })`.
3. If the result indicates command-not-found / spawn failure, try `pi.exec("uvx", ["ddgr", ...args], ...)`.
4. Use `--json`, `--num`, `--np`, and `--expand`/safe no-color options where supported.
5. Parse stdout JSON, normalize to:
   ```ts
   { title: string; url: string; snippet: string }
   ```
6. Return compact text plus structured details.

Fallback/error behavior:

- If both runners fail, return an actionable setup message mentioning `brew install ddgr` or relying on `uvx ddgr`.
- If stdout is invalid JSON, include truncated stdout/stderr in the tool error message.
- If no results, return `No results found` with empty details.

### `fetch_content` tool

Parameters:

```ts
{
  url: string;
  maxChars?: number; // clamp 1_000..50_000, default 20_000
}
```

Execution:

1. Validate URL protocol is `http:` or `https:` only, and block localhost/private/link-local literal hosts by default to reduce SSRF risk.
2. Fetch using Node global `fetch` with `AbortSignal.timeout` or a manual abort tied to the tool signal; handle redirects manually and validate every redirect target before following it.
3. Reject non-2xx with a clear message and reject responses above a bounded raw byte cap before output truncation.
4. Detect content type:
   - `text/html`: run local simple extractor.
   - `text/plain`, markdown, json-ish: return normalized text directly.
   - other content types: return an unsupported content-type message.
5. Local simple extractor:
   - remove script/style/noscript/svg blocks,
   - remove comments,
   - convert key block boundaries/headings/list items/paragraphs to newlines,
   - strip tags,
   - decode common HTML entities plus numeric entities after tag stripping so escaped literal markup remains text,
   - collapse whitespace and blank lines.
6. Truncate returned text to `maxChars` and report truncation in content/details.

Non-goals for first version:

- No MCP.
- No Jina Reader or hosted extraction.
- No browser automation/Playwright.
- No cookies/authenticated pages.
- No image/video understanding.
- No batch search unless tests reveal it is trivial without complicating the schema.

## TDD implementation chunks

### Chunk 1 — `web_search` happy path and runner fallback

1. RED: Add `tests/web-search-extension.test.mjs` fake Pi API with `exec` stubs. Test that `web_search` registers and parses installed-`ddgr` JSON into text and details.
2. GREEN: Implement minimal `extensions/web-search/index.ts` with `web_search` tool and `ddgr` execution.
3. RED: Add test where `ddgr` fails command-not-found and `uvx ddgr` succeeds.
4. GREEN: Implement runner fallback.
5. Verification checkpoint: `npm test` passes.

### Chunk 2 — `web_search` validation and errors

1. RED: Tests for empty query, clamped `numResults`, no-results output, invalid JSON, and both runners failing.
2. GREEN: Implement validation, clamp, and error formatting.
3. Verification checkpoint: `npm test` passes; manually run `uvx ddgr --json --num 2 "pi coding agent" | jq .` to verify actual output still matches parser assumptions.

### Chunk 3 — `fetch_content` local extractor

1. RED: Tests with mocked global `fetch` for HTML extraction, entity decoding, script/style removal, plain text passthrough, invalid URL protocol, non-2xx response, unsupported content type, and truncation.
2. GREEN: Implement `fetch_content` with local simple extractor and truncation.
3. Verification checkpoint: `npm test` passes.

### Chunk 4 — Documentation

1. Update `README.md` and add `extensions/web-search/README.md`.
2. Verification checkpoint: `npm test` passes; `grep -R "web_search\|fetch_content\|ddgr" README.md extensions/web-search/README.md` shows the documented command/tool names.

### Optional runtime smoke check after implementation

If practical, run a Pi one-shot or extension-local harness to call `web_search` with a real query. If Pi print/json mode cannot easily invoke extension tools directly, use a small Node script or document why the runtime smoke was skipped. Unit tests remain the required gate.

## Edge cases and failure modes

- `ddgr` changes JSON shape: parser should tolerate missing `abstract` by using empty snippet; invalid top-level shape returns a parse error with truncated stdout.
- `uvx ddgr` first run takes time or network fails: timeout at 30 seconds; return clear stderr.
- DuckDuckGo rate-limits/challenges: expose stderr/stdout context and suggest retrying later; do not loop.
- Query contains shell metacharacters: use `pi.exec(command, args)` with arg array, never concatenate shell strings.
- Very broad `numResults`: clamp to avoid context bloat.
- Fetch redirects: follow redirects manually, validate each target before fetching, and stop after a small redirect limit.
- Large responses: check `Content-Length` where present and stream with a raw byte cap before output truncation.
- Fetch binary content: reject by content type before trying text extraction when possible.
- HTML entity decoding is incomplete: decode common and numeric entities after tag stripping; invalid numeric code points remain unchanged; document that this is a simple extractor.
- Pages with client-side rendering: simple extractor may return sparse content; report extracted character count and leave URL in details.
- Tool cancellation: pass `ctx.signal`/tool signal to `pi.exec` and fetch abort handling.

## Blast radius

- Adds a new extension directory only.
- Adds a new test file only.
- Updates root README extension list.
- Introduces active tool names `web_search` and `fetch_content`; grep verified no current collisions.
- No changes to existing extensions expected.

## Pre-mortem

1. `uvx ddgr` is not a stable fallback on every machine. Mitigation: try installed `ddgr` first, document setup, and make both-runner failure messages actionable.
2. Local HTML extraction produces poor content for modern JavaScript-heavy pages. Mitigation: explicitly document it as simple extraction, include URL/title metadata, and avoid promising full browser rendering.
3. Search/fetch output floods context. Mitigation: clamp `numResults`, cap `maxChars`, and include truncation markers/details.

## Planning Verification

- [x] Every file/line reference was read directly by me (not from subagent summary alone)
- [x] I ran diagnostic commands myself for facts in the plan (`git status`, `grep`, `find`, `uvx ddgr --help`, `uvx ddgr --json`, package/repo metadata checks)
- [x] Each step has a verification checkpoint with concrete command and expected outcome
- [x] I searched for existing patterns before proposing new ones
- [x] I checked current filesystem state for counts, paths, and names
- [x] Blast radius listed if shared code is touched (all usages traced)
- [x] Edge cases documented for every integration point and data transformation
