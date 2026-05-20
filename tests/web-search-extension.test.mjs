import assert from "node:assert/strict";
import test from "node:test";

async function loadWebSearchExtension({ execImpl, fetchImpl } = {}) {
	const moduleUrl = new URL(`../extensions/web-search/index.ts?test=${Date.now()}-${Math.random()}`, import.meta.url);
	const { default: extension } = await import(moduleUrl.href);

	const tools = new Map();
	const execCalls = [];
	const pi = {
		registerTool(spec) { tools.set(spec.name, spec); },
		async exec(command, args, options) {
			execCalls.push({ command, args, options });
			if (!execImpl) throw new Error(`Unexpected exec: ${command}`);
			return execImpl(command, args, options);
		},
	};
	extension(pi);

	const ctx = { cwd: process.cwd(), signal: undefined, fetch: fetchImpl };
	return { tools, execCalls, ctx, fetchImpl };
}

test("web_search parses ddgr JSON results", async () => {
	const { tools, execCalls, ctx } = await loadWebSearchExtension({
		execImpl: async () => ({
			code: 0,
			stdout: JSON.stringify([
				{ title: "Pi Coding Agent", url: "https://pi.dev/packages", abstract: "Package catalog." },
			]),
			stderr: "",
		}),
	});

	const result = await tools.get("web_search").execute("search-1", { query: "pi coding agent", numResults: 3 }, undefined, undefined, ctx);

	assert.equal(execCalls[0].command, "ddgr");
	assert.deepEqual(execCalls[0].args, ["--json", "--np", "--num", "3", "pi coding agent"]);
	assert.match(result.content[0].text, /1\. Pi Coding Agent/);
	assert.match(result.content[0].text, /https:\/\/pi\.dev\/packages/);
	assert.equal(result.details.results[0].snippet, "Package catalog.");
});

test("web_search falls back to uvx ddgr when ddgr is missing", async () => {
	const { tools, execCalls, ctx } = await loadWebSearchExtension({
		execImpl: async (command) => {
			if (command === "ddgr") return { code: 127, stdout: "", stderr: "command not found: ddgr" };
			return { code: 0, stdout: JSON.stringify([{ title: "Fallback", url: "https://example.com", abstract: "via uvx" }]), stderr: "" };
		},
	});

	const result = await tools.get("web_search").execute("search-1", { query: "fallback" }, undefined, undefined, ctx);

	assert.equal(execCalls[0].command, "ddgr");
	assert.equal(execCalls[1].command, "uvx");
	assert.deepEqual(execCalls[1].args, ["ddgr", "--json", "--np", "--num", "5", "fallback"]);
	assert.match(result.content[0].text, /Fallback/);
	assert.equal(result.details.runner, "uvx ddgr");
});

test("web_search falls back to uvx when ddgr spawn rejects", async () => {
	const { tools, execCalls, ctx } = await loadWebSearchExtension({
		execImpl: async (command) => {
			if (command === "ddgr") throw new Error("spawn ddgr ENOENT");
			return { code: 0, stdout: JSON.stringify([{ title: "Fallback", url: "https://example.com", abstract: "via uvx" }]), stderr: "" };
		},
	});

	const result = await tools.get("web_search").execute("search-1", { query: "fallback" }, undefined, undefined, ctx);

	assert.equal(execCalls[0].command, "ddgr");
	assert.equal(execCalls[1].command, "uvx");
	assert.equal(result.details.runner, "uvx ddgr");
});

test("web_search treats empty code 1 ddgr result as missing command", async () => {
	const { tools, execCalls, ctx } = await loadWebSearchExtension({
		execImpl: async (command) => {
			if (command === "ddgr") return { code: 1, stdout: "", stderr: "" };
			return { code: 0, stdout: JSON.stringify([{ title: "Fallback", url: "https://example.com", abstract: "via uvx" }]), stderr: "" };
		},
	});

	const result = await tools.get("web_search").execute("search-1", { query: "fallback" }, undefined, undefined, ctx);

	assert.equal(execCalls[0].command, "ddgr");
	assert.equal(execCalls[1].command, "uvx");
	assert.equal(result.details.runner, "uvx ddgr");
});

test("web_search validates query and clamps result count", async () => {
	const { tools, execCalls, ctx } = await loadWebSearchExtension({
		execImpl: async () => ({ code: 0, stdout: "[]", stderr: "" }),
	});

	await assert.rejects(
		() => tools.get("web_search").execute("search-1", { query: "   " }, undefined, undefined, ctx),
		/non-empty query/,
	);

	const result = await tools.get("web_search").execute("search-2", { query: "many", numResults: 100 }, undefined, undefined, ctx);
	assert.deepEqual(execCalls[0].args, ["--json", "--np", "--num", "10", "many"]);
	assert.match(result.content[0].text, /No results found/);
	assert.deepEqual(result.details.results, []);
});

test("web_search reports invalid JSON and runner failures", async () => {
	const invalid = await loadWebSearchExtension({
		execImpl: async () => ({ code: 0, stdout: "not json", stderr: "" }),
	});
	await assert.rejects(
		() => invalid.tools.get("web_search").execute("search-1", { query: "bad json" }, undefined, undefined, invalid.ctx),
		/invalid JSON/,
	);

	const failed = await loadWebSearchExtension({
		execImpl: async (command) => {
			if (command === "ddgr") return { code: 127, stdout: "", stderr: "command not found" };
			return { code: 2, stdout: "", stderr: "uvx failed" };
		},
	});
	await assert.rejects(
		() => failed.tools.get("web_search").execute("search-2", { query: "runner fail" }, undefined, undefined, failed.ctx),
		/web_search failed with uvx ddgr.*brew install ddgr.*uvx failed/s,
	);
});

test("fetch_content extracts readable text from HTML locally", async () => {
	const { tools, ctx } = await loadWebSearchExtension({
		fetchImpl: async (url) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			url,
			headers: { get(name) { return name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null; } },
			async text() {
				return `<!doctype html><html><head><title>Example &amp; Test</title><style>.x{}</style><script>bad()</script></head><body><h1>Hello&nbsp;World</h1><p>First &amp; second.</p><p>&lt;notatag&gt;visible&lt;/notatag&gt; &#9999999999;</p><ul><li>One</li><li>Two</li></ul></body></html>`;
			},
		}),
	});

	const result = await tools.get("fetch_content").execute("fetch-1", { url: "https://example.com/page" }, undefined, undefined, ctx);

	assert.match(result.content[0].text, /Hello World/);
	assert.match(result.content[0].text, /First & second\./);
	assert.match(result.content[0].text, /<notatag>visible<\/notatag>/);
	assert.match(result.content[0].text, /One/);
	assert.doesNotMatch(result.content[0].text, /bad\(\)/);
	assert.equal(result.details.contentType, "text/html; charset=utf-8");
	assert.equal(result.details.truncated, false);
});

test("fetch_content handles text, validation, HTTP errors, unsupported content, and truncation", async () => {
	await assert.rejects(async () => {
		const { tools, ctx } = await loadWebSearchExtension({ fetchImpl: async () => { throw new Error("should not fetch"); } });
		await tools.get("fetch_content").execute("fetch-1", { url: "file:///etc/passwd" }, undefined, undefined, ctx);
	}, /HTTP or HTTPS/);

	await assert.rejects(async () => {
		const { tools, ctx } = await loadWebSearchExtension({ fetchImpl: async () => { throw new Error("should not fetch"); } });
		await tools.get("fetch_content").execute("fetch-private", { url: "http://127.0.0.1:3000" }, undefined, undefined, ctx);
	}, /private-network/);

	await assert.rejects(async () => {
		const { tools, ctx } = await loadWebSearchExtension({ fetchImpl: async () => { throw new Error("should not fetch"); } });
		await tools.get("fetch_content").execute("fetch-ipv6-private", { url: "http://[::ffff:127.0.0.1]/" }, undefined, undefined, ctx);
	}, /private-network/);

	const publicDomain = await loadWebSearchExtension({
		fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", url: "https://fdroid.org/", headers: { get() { return "text/plain"; } }, async text() { return "public domain"; } }),
	});
	const publicResult = await publicDomain.tools.get("fetch_content").execute("fetch-public", { url: "https://fdroid.org/" }, undefined, undefined, publicDomain.ctx);
	assert.match(publicResult.content[0].text, /public domain/);

	const httpError = await loadWebSearchExtension({
		fetchImpl: async () => ({ ok: false, status: 404, statusText: "Not Found", headers: { get() { return "text/html"; } }, async text() { return "missing"; } }),
	});
	await assert.rejects(
		() => httpError.tools.get("fetch_content").execute("fetch-2", { url: "https://example.com/missing" }, undefined, undefined, httpError.ctx),
		/HTTP 404 Not Found/,
	);

	const unsupported = await loadWebSearchExtension({
		fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", headers: { get() { return "image/png"; } }, async text() { return "png"; } }),
	});
	await assert.rejects(
		() => unsupported.tools.get("fetch_content").execute("fetch-3", { url: "https://example.com/image.png" }, undefined, undefined, unsupported.ctx),
		/Unsupported content type/,
	);

	const text = await loadWebSearchExtension({
		fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", headers: { get() { return "text/plain"; } }, async text() { return "abcdef".repeat(300); } }),
	});
	const result = await text.tools.get("fetch_content").execute("fetch-4", { url: "https://example.com/plain.txt", maxChars: 1000 }, undefined, undefined, text.ctx);
	assert.match(result.content[0].text, /abcdef/);
	assert.match(result.content[0].text, /truncated/);
	assert.equal(result.details.truncated, true);
});
