import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

type SearchResult = {
	title: string;
	url: string;
	snippet: string;
};

const DEFAULT_RESULTS = 5;
const MIN_RESULTS = 1;
const MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 30_000;
const DDG_HTML_SEARCH_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_FETCH_CHARS = 20_000;
const MIN_FETCH_CHARS = 1_000;
const MAX_FETCH_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

function stringEnum<T extends readonly string[]>(values: T, options?: { description?: string }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
	});
}

const webSearchParameters = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(Type.Number({ description: "Number of results to return (1-10, default 5)" })),
	region: Type.Optional(Type.String({ description: "Optional ddgr region, for example us-en or de-de" })),
	time: Type.Optional(stringEnum(["d", "w", "m", "y"] as const, { description: "Optional time filter: d, w, m, or y" })),
	site: Type.Optional(Type.String({ description: "Optional site/domain filter passed to ddgr --site" })),
}, { additionalProperties: false });

type WebSearchParameters = Static<typeof webSearchParameters>;

const fetchContentParameters = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
	maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return (1000-50000, default 20000)" })),
}, { additionalProperties: false });

type FetchContentParameters = Static<typeof fetchContentParameters>;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) return { text: value, truncated: false };
	return { text: `${value.slice(0, maxChars)}\n… (${value.length - maxChars} more chars truncated)`, truncated: true };
}

function normalizeSearchQuery(params: WebSearchParameters): string {
	const query = typeof params.query === "string" ? params.query.trim() : "";
	if (!query) throw new Error("web_search requires a non-empty query.");
	return query;
}

function isSearchTime(value: unknown): value is "d" | "w" | "m" | "y" {
	return value === "d" || value === "w" || value === "m" || value === "y";
}

function buildDdgrArgs(params: WebSearchParameters): string[] {
	const query = normalizeSearchQuery(params);
	const args = ["--json", "--np", "--num", String(clampInteger(params.numResults, DEFAULT_RESULTS, MIN_RESULTS, MAX_RESULTS))];
	if (typeof params.region === "string" && params.region.trim()) args.push("--reg", params.region.trim());
	if (isSearchTime(params.time)) args.push("--time", params.time);
	if (typeof params.site === "string" && params.site.trim()) args.push("--site", params.site.trim());
	args.push(query);
	return args;
}

function buildDdgHtmlSearchUrl(params: WebSearchParameters): URL {
	let query = normalizeSearchQuery(params);
	if (typeof params.site === "string" && params.site.trim()) query = `site:${params.site.trim()} ${query}`;
	const url = new URL(DDG_HTML_SEARCH_URL);
	url.searchParams.set("q", query);
	if (typeof params.region === "string" && params.region.trim()) url.searchParams.set("kl", params.region.trim());
	if (isSearchTime(params.time)) url.searchParams.set("df", params.time);
	return url;
}

function isMissingCommand(result: any): boolean {
	const stdout = String(result?.stdout ?? "");
	const stderr = String(result?.stderr ?? "").toLowerCase();
	return result?.code === 127
		|| (result?.code === 1 && stdout.trim() === "" && stderr.trim() === "")
		|| stderr.includes("command not found")
		|| stderr.includes("not found")
		|| stderr.includes("enoent");
}

function parseSearchResults(stdout: string, stderr = ""): SearchResult[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		const stdoutPreview = truncate(stdout, 1200).text;
		const stderrPreview = truncate(stderr, 1200).text;
		throw new Error(`ddgr returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\nstdout: ${stdoutPreview}\nstderr: ${stderrPreview}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`ddgr returned JSON that was not an array. stdout: ${truncate(stdout, 1200).text}`);
	return parsed
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			const raw = item as Record<string, unknown>;
			const title = typeof raw.title === "string" ? raw.title.trim() : "";
			const url = typeof raw.url === "string" ? raw.url.trim() : "";
			const snippet = typeof raw.abstract === "string" ? raw.abstract.trim() : "";
			if (!title && !url) return undefined;
			return { title: title || url, url, snippet };
		})
		.filter(Boolean) as SearchResult[];
}

function formatSearchResults(results: SearchResult[], runner: string): string {
	if (results.length === 0) return `No results found. (runner: ${runner})`;
	const lines = [`Web search results (runner: ${runner})`];
	results.forEach((result, index) => {
		lines.push(`${index + 1}. ${result.title}`);
		if (result.url) lines.push(`   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
	});
	return lines.join("\n");
}

function normalizeDdgResultUrl(rawHref: string): string {
	const href = decodeHtmlEntities(rawHref).trim();
	try {
		const url = new URL(href.startsWith("//") ? `https:${href}` : href, "https://duckduckgo.com");
		const unwrapped = url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/" ? url.searchParams.get("uddg") : undefined;
		if (unwrapped) return unwrapped;
		return url.toString();
	} catch {
		return href;
	}
}

function parseDdgHtmlResults(html: string, maxResults: number): SearchResult[] {
	const anchorPattern = /<a\b(?=[^>]*\bclass=(['"])[^'"]*\bresult__a\b[^'"]*\1)[^>]*\bhref=(['"])(.*?)\2[^>]*>([\s\S]*?)<\/a>/gi;
	const anchors = [...html.matchAll(anchorPattern)].map((match) => ({
		index: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
		href: match[3] ?? "",
		titleHtml: match[4] ?? "",
	}));
	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();
	for (let index = 0; index < anchors.length && results.length < maxResults; index++) {
		const anchor = anchors[index];
		const title = extractHtmlText(anchor.titleHtml);
		const url = normalizeDdgResultUrl(anchor.href);
		if (!title && !url) continue;
		if (url && seenUrls.has(url)) continue;
		const nextAnchorIndex = anchors[index + 1]?.index ?? html.length;
		const resultWindow = html.slice(anchor.end, nextAnchorIndex);
		const snippetMatch = resultWindow.match(/<([a-z0-9]+)\b[^>]*\bclass=(['"])[^'"]*\bresult__snippet\b[^'"]*\2[^>]*>([\s\S]*?)<\/\1>/i);
		const snippet = snippetMatch ? extractHtmlText(snippetMatch[3] ?? "") : "";
		if (url) seenUrls.add(url);
		results.push({ title: title || url, url, snippet });
	}
	return results;
}

function decodeHtmlEntities(value: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower.startsWith("#x")) {
			const code = Number.parseInt(lower.slice(2), 16);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		if (lower.startsWith("#")) {
			const code = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return named[lower] ?? match;
	});
}

function extractHtmlText(html: string): string {
	return decodeHtmlEntities(html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "\n")
		.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "\n")
		.replace(/<!--([\s\S]*?)-->/g, "\n")
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|header|footer|main|li|ul|ol|h[1-6]|tr|table)>/gi, "\n")
		.replace(/<\s*li\b[^>]*>/gi, "\n- ")
		.replace(/<[^>]+>/g, " ")
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.replace(/\n{3,}/g, "\n\n"))
		.trim();
}

function normalizePlainText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isSupportedTextContent(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return lower.startsWith("text/") || lower.includes("json") || lower.includes("xml") || lower.includes("markdown");
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}

function isBlockedPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || isPrivateIpv4(host)) return true;
	if (!host.includes(":")) return false;
	return host === "::1"
		|| host.startsWith("::ffff:")
		|| host.startsWith("fe80:")
		|| /^f[cd][0-9a-f]{0,2}:/i.test(host);
}

function validateHttpUrl(rawUrl: unknown): URL {
	if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new Error("fetch_content requires a URL.");
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		throw new Error("fetch_content requires a valid URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("fetch_content only supports HTTP or HTTPS URLs.");
	if (isBlockedPrivateHost(url.hostname)) throw new Error("fetch_content blocks local and private-network URLs by default.");
	return url;
}

function getFetch(ctx: any): typeof fetch {
	return typeof ctx?.fetch === "function" ? ctx.fetch : fetch;
}

async function fetchWithAbort(fetchFn: typeof fetch, url: URL, signal: AbortSignal | undefined) {
	if (signal?.aborted) throw new Error("fetch_content aborted before request started.");
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	let combinedSignal = timeout;
	if (signal) {
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		timeout.addEventListener("abort", abort, { once: true });
		combinedSignal = controller.signal;
	}
	return fetchFn(url.toString(), { signal: combinedSignal, redirect: "manual" });
}

async function fetchFollowingSafeRedirects(fetchFn: typeof fetch, startUrl: URL, signal: AbortSignal | undefined) {
	let url = startUrl;
	for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
		validateHttpUrl(url.toString());
		const response = await fetchWithAbort(fetchFn, url, signal);
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		url = validateHttpUrl(new URL(location, url).toString());
	}
	throw new Error(`fetch_content exceeded ${MAX_REDIRECTS} redirects.`);
}

async function readResponseTextLimited(response: Response): Promise<string> {
	const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_BYTES) {
		throw new Error(`fetch_content response is too large (${contentLength} bytes; max ${MAX_FETCH_BYTES}).`);
	}

	if (!response.body) return response.text();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > MAX_FETCH_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`fetch_content response is too large (over ${MAX_FETCH_BYTES} bytes).`);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchSearchWithAbort(fetchFn: typeof fetch, url: URL, signal: AbortSignal | undefined) {
	if (signal?.aborted) throw new Error("web_search aborted before request started.");
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let combinedSignal = timeout;
	if (signal) {
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		timeout.addEventListener("abort", abort, { once: true });
		combinedSignal = controller.signal;
	}
	return fetchFn(url.toString(), {
		signal: combinedSignal,
		redirect: "follow",
		headers: {
			accept: "text/html,application/xhtml+xml",
			"user-agent": "Mozilla/5.0 (compatible; pi-web-search/0.1; +https://github.com/earendil-works/pi)",
		},
	});
}

async function runDdgHtmlSearch(ctx: any, params: WebSearchParameters, signal: AbortSignal | undefined) {
	const url = buildDdgHtmlSearchUrl(params);
	const response = await fetchSearchWithAbort(getFetch(ctx), url, signal);
	if (!response.ok) throw new Error(`DuckDuckGo HTML search failed: HTTP ${response.status} ${response.statusText}`.trim());
	const html = await readResponseTextLimited(response);
	const results = parseDdgHtmlResults(html, clampInteger(params.numResults, DEFAULT_RESULTS, MIN_RESULTS, MAX_RESULTS));
	if (results.length === 0 && /(captcha|anomaly|challenge|consent)/i.test(html)) {
		throw new Error("DuckDuckGo HTML search returned a challenge/consent page instead of results.");
	}
	return { runner: "duckduckgo html", searchUrl: url.toString(), results };
}

async function runDdgr(pi: ExtensionAPI, args: string[], signal: AbortSignal | undefined) {
	let ddgr: any;
	try {
		ddgr = await pi.exec("ddgr", args, { signal, timeout: SEARCH_TIMEOUT_MS });
	} catch (error) {
		if (signal?.aborted) throw error;
		ddgr = { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
	if (ddgr.code === 0) return { runner: "ddgr", result: ddgr };
	if (!isMissingCommand(ddgr)) return { runner: "ddgr", result: ddgr };
	try {
		const uvx = await pi.exec("uvx", ["ddgr", ...args], { signal, timeout: SEARCH_TIMEOUT_MS });
		return { runner: "uvx ddgr", result: uvx };
	} catch (error) {
		if (signal?.aborted) throw error;
		return { runner: "uvx ddgr", result: { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) } };
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search DuckDuckGo using native fetch against the HTML endpoint first. Falls back to `ddgr` / `uvx ddgr` when native search fails. Returns titles, URLs, and snippets.",
		promptSnippet: "Search the web with DuckDuckGo native HTML fetch, with ddgr fallback",
		promptGuidelines: ["Use web_search when current web information is needed before answering or implementing."],
		parameters: webSearchParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let nativeError: unknown;
			try {
				const native = await runDdgHtmlSearch(ctx, params, signal);
				return {
					content: [{ type: "text", text: formatSearchResults(native.results, native.runner) }],
					details: { query: params.query, runner: native.runner, searchUrl: native.searchUrl, results: native.results },
				};
			} catch (error) {
				if (signal?.aborted) throw error;
				nativeError = error;
			}

			const args = buildDdgrArgs(params);
			const { runner, result } = await runDdgr(pi, args, signal);
			if (result.code !== 0) {
				const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
				throw new Error(`web_search failed with native DuckDuckGo search (${nativeMessage}) and ${runner} (exit ${result.code}). Install ddgr (for example: brew install ddgr) or ensure uvx can run ddgr. stderr: ${truncate(String(result.stderr ?? ""), 2000).text}`);
			}
			const results = parseSearchResults(String(result.stdout ?? ""), String(result.stderr ?? ""));
			return {
				content: [{ type: "text", text: formatSearchResults(results, runner) }],
				details: { query: params.query, runner, nativeError: nativeError instanceof Error ? nativeError.message : String(nativeError), results },
			};
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch an HTTP(S) page and extract readable text locally with a simple HTML stripper. No hosted reader service or MCP is used.",
		promptSnippet: "Fetch a URL and extract readable text locally",
		parameters: fetchContentParameters,
		async execute(_toolCallId, params: FetchContentParameters, signal, _onUpdate, ctx) {
			const url = validateHttpUrl(params.url);
			const maxChars = clampInteger(params.maxChars, DEFAULT_FETCH_CHARS, MIN_FETCH_CHARS, MAX_FETCH_CHARS);
			const response = await fetchFollowingSafeRedirects(getFetch(ctx), url, signal);
			if (!response.ok) throw new Error(`fetch_content failed: HTTP ${response.status} ${response.statusText}`.trim());

			const contentType = response.headers.get("content-type") ?? "";
			if (contentType && !isSupportedTextContent(contentType)) {
				throw new Error(`Unsupported content type: ${contentType}`);
			}

			const raw = await readResponseTextLimited(response);
			const isHtml = contentType.toLowerCase().includes("html") || /<html[\s>]/i.test(raw) || /<body[\s>]/i.test(raw);
			const extracted = isHtml ? extractHtmlText(raw) : normalizePlainText(raw);
			const truncated = truncate(extracted, maxChars);
			const finalUrl = response.url || url.toString();
			return {
				content: [{ type: "text", text: `Fetched: ${finalUrl}\nContent-Type: ${contentType || "unknown"}\n\n${truncated.text}` }],
				details: {
					url: url.toString(),
					finalUrl,
					contentType,
					extractedChars: extracted.length,
					truncated: truncated.truncated,
				},
			};
		},
	});
}
