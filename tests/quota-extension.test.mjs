import assert from "node:assert/strict";
import test from "node:test";

async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for quota extension update");
}

async function loadQuotaExtension({ auth = {}, fetchImpl, model, useGlobalFetch = false } = {}) {
	const moduleUrl = new URL(`../extensions/quota/index.ts?test=${Date.now()}-${Math.random()}`, import.meta.url);
	const { default: extension } = await import(moduleUrl.href);

	const hooks = new Map();
	const commands = new Map();
	const statuses = new Map();
	const notifications = [];
	const fetchCalls = [];
	const pi = {
		on(name, callback) { hooks.set(name, callback); },
		registerCommand(name, spec) { commands.set(name, spec); },
	};
	extension(pi);

	const ctx = {
		mode: "tui",
		hasUI: true,
		model,
		ui: {
			setStatus(key, value) { statuses.set(key, value); },
			notify(message, level) { notifications.push({ message, level }); },
		},
		modelRegistry: {
			async getApiKeyForProvider(provider) {
				if (auth[provider] instanceof Error) throw auth[provider];
				return auth[provider];
			},
		},
	};
	if (!useGlobalFetch) {
		ctx.fetch = async (url, options) => {
			fetchCalls.push({ url, options });
			if (!fetchImpl) throw new Error(`Unexpected fetch: ${url}`);
			return fetchImpl(url, options);
		};
	}

	return { hooks, commands, statuses, notifications, fetchCalls, ctx };
}

function jsonResponse(value, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		async json() { return value; },
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((res) => { resolve = res; });
	return { promise, resolve };
}

test("blank numeric fields remain unavailable instead of fabricating quota", async () => {
	const harness = await loadQuotaExtension({
		auth: {
			"openai-codex": "header.payload.signature",
			"kimi-coding": "kimi-secret",
		},
		fetchImpl: async (url) => url.includes("chatgpt.com")
			? jsonResponse({
				rate_limit: {
					primary_window: { used_percent: " ", limit_window_seconds: 18_000 },
				},
			})
			: jsonResponse({
				usage: { limit: "100", remaining: "" },
			}),
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await harness.commands.get("quota").handler("refresh", harness.ctx);
	assert.equal(harness.fetchCalls.length, 2);
	assert.equal(harness.statuses.get("quota"), "Codex ? | Kimi ?");

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});

test("shows exact Codex remaining quota in the compact status", async () => {
	const token = "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xMjMifX0.signature";
	const harness = await loadQuotaExtension({
		auth: { "openai-codex": token },
		fetchImpl: async () => jsonResponse({
			plan_type: "plus",
			rate_limit: {
				primary_window: { used_percent: 38, limit_window_seconds: 18_000, reset_after_seconds: 3600 },
				secondary_window: { used_percent: 21, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
			},
		}),
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.statuses.get("quota")?.includes("Codex 5h 62% · wk 79%"));

	assert.equal(harness.fetchCalls[0].url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(harness.fetchCalls[0].options.headers.Authorization, `Bearer ${token}`);
	assert.equal(harness.fetchCalls[0].options.headers["ChatGPT-Account-Id"], "acct_123");
	assert.equal(harness.fetchCalls[0].options.redirect, "error");
	assert.doesNotMatch(harness.statuses.get("quota"), /header|acct_123/);

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});

test("shows exact Kimi rolling and weekly quota in the compact status", async () => {
	const harness = await loadQuotaExtension({
		auth: { "kimi-coding": "kimi-secret" },
		fetchImpl: async (url) => {
			assert.equal(url, "https://api.kimi.com/coding/v1/usages");
			return jsonResponse({
				usage: { limit: "100", remaining: "74", resetTime: "2026-06-21T00:14:00Z" },
				limits: [{
					window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
					detail: { limit: 100, remaining: 88, resetTime: "2026-06-17T01:14:00Z" },
				}],
			});
		},
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.statuses.get("quota") === "Kimi 5h 88% · wk 74%");

	assert.equal(harness.fetchCalls[0].options.headers.Authorization, "Bearer kimi-secret");
	assert.equal(harness.fetchCalls[0].options.redirect, "error");
	assert.doesNotMatch(harness.statuses.get("quota"), /kimi-secret/);

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});

test("updates Codex quota immediately from provider-specific response headers", async () => {
	const harness = await loadQuotaExtension();

	await harness.hooks.get("after_provider_response")?.({
		status: 200,
		headers: {
			"x-codex-primary-used-percent": "40.5",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-after-seconds": "600",
			"x-codex-secondary-used-percent": "12",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-after-seconds": "7200",
		},
	}, harness.ctx);

	assert.equal(harness.statuses.get("quota"), "Codex 5h 60% · wk 88%");

	await harness.hooks.get("after_provider_response")?.({
		status: 200,
		headers: { "x-ratelimit-remaining-requests": "10" },
	}, harness.ctx);
	assert.equal(harness.statuses.get("quota"), "Codex 5h 60% · wk 88%");
});

test("refreshes Kimi after use and preserves last-known values as stale on failure", async () => {
	let shouldFail = false;
	let pendingResponse;
	const success = (weekly = 70) => jsonResponse({
		usage: { limit: 100, remaining: weekly },
		limits: [{
			window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
			detail: { limit: 100, remaining: 80 },
		}],
	});
	const harness = await loadQuotaExtension({
		auth: { "kimi-coding": "kimi-secret" },
		model: { provider: "kimi-coding", id: "kimi-for-coding" },
		fetchImpl: async () => pendingResponse?.promise ?? (shouldFail ? jsonResponse({}, 429) : success()),
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.statuses.get("quota") === "Kimi 5h 80% · wk 70%");

	shouldFail = true;
	await harness.hooks.get("agent_end")?.({}, harness.ctx);
	await waitFor(() => harness.statuses.get("quota") === "Kimi 5h 80% · wk 70%~");

	shouldFail = false;
	pendingResponse = deferred();
	const refresh = harness.commands.get("quota").handler("refresh", harness.ctx);
	await waitFor(() => harness.fetchCalls.length === 3);
	assert.equal(harness.statuses.get("quota"), "Kimi 5h 80% · wk 70%~");
	pendingResponse.resolve(success(60));
	await refresh;
	assert.equal(harness.statuses.get("quota"), "Kimi 5h 80% · wk 60%");

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});

test("coalesces overlapping Kimi triggers into one post-use refresh", async () => {
	const firstResponse = deferred();
	const secondResponse = deferred();
	const responses = [firstResponse, secondResponse];
	const harness = await loadQuotaExtension({
		auth: { "kimi-coding": "kimi-secret" },
		model: { provider: "kimi-coding", id: "kimi-for-coding" },
		fetchImpl: async () => responses.shift().promise,
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.fetchCalls.length === 1);
	await harness.hooks.get("agent_end")?.({}, harness.ctx);
	await harness.hooks.get("agent_end")?.({}, harness.ctx);
	assert.equal(harness.fetchCalls.length, 1);

	firstResponse.resolve(jsonResponse({ usage: { limit: 100, remaining: 90 } }));
	await waitFor(() => harness.fetchCalls.length === 2);
	secondResponse.resolve(jsonResponse({ usage: { limit: 100, remaining: 80 } }));
	await waitFor(() => harness.statuses.get("quota") === "Kimi wk 80%");
	assert.equal(harness.fetchCalls.length, 2);

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});

test("a late Codex poll cannot overwrite newer response-header quota", async () => {
	const response = deferred();
	const harness = await loadQuotaExtension({
		auth: { "openai-codex": "header.payload.signature" },
		fetchImpl: async () => response.promise,
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.fetchCalls.length === 1);
	await harness.hooks.get("after_provider_response")?.({
		status: 200,
		headers: {
			"x-codex-primary-used-percent": "20",
			"x-codex-primary-window-minutes": "300",
			"x-codex-secondary-used-percent": "30",
			"x-codex-secondary-window-minutes": "10080",
		},
	}, harness.ctx);
	assert.equal(harness.statuses.get("quota"), "Codex 5h 80% · wk 70%");

	response.resolve(jsonResponse({
		rate_limit: {
			primary_window: { used_percent: 90, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: 80, limit_window_seconds: 604_800 },
		},
	}));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(harness.statuses.get("quota"), "Codex 5h 80% · wk 70%");

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});

test("/quota shows details and refreshes provider values on demand", async () => {
	let remaining = 75;
	const harness = await loadQuotaExtension({
		auth: { "kimi-coding": "kimi-secret" },
		fetchImpl: async () => jsonResponse({
			usage: { limit: 100, remaining, resetTime: new Date(Date.now() + 3_600_000).toISOString() },
		}),
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.statuses.get("quota") === "Kimi wk 75%");
	await harness.commands.get("quota").handler("", harness.ctx);
	assert.match(harness.notifications.at(-1).message, /Kimi Code/);
	assert.match(harness.notifications.at(-1).message, /Weekly: 75% remaining/);
	assert.match(harness.notifications.at(-1).message, /resets in/);

	remaining = 60;
	await harness.commands.get("quota").handler("refresh", harness.ctx);
	assert.equal(harness.statuses.get("quota"), "Kimi wk 60%");
	assert.match(harness.notifications.at(-1).message, /Weekly: 60% remaining/);

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});

test("never renders secrets from authentication failures", async () => {
	const harness = await loadQuotaExtension({
		auth: { "kimi-coding": new Error("auth failed for secret-token-123") },
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.statuses.get("quota") === "Kimi ?");
	await harness.commands.get("quota").handler("", harness.ctx);

	assert.doesNotMatch(harness.statuses.get("quota"), /secret-token-123/);
	assert.doesNotMatch(harness.notifications.at(-1).message, /secret-token-123/);
	assert.match(harness.notifications.at(-1).message, /Authentication failed/);

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});

test("uses the global fetch path provided by real ExtensionContext", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	let harness;
	globalThis.fetch = async (url, options) => {
		calls.push({ url, options });
		return jsonResponse({ usage: { limit: 100, remaining: 55 } });
	};
	try {
		harness = await loadQuotaExtension({
			auth: { "kimi-coding": "kimi-secret" },
			useGlobalFetch: true,
		});
		await harness.hooks.get("session_start")?.({}, harness.ctx);
		await waitFor(() => harness.statuses.get("quota") === "Kimi wk 55%");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://api.kimi.com/coding/v1/usages");
	} finally {
		if (harness) await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
		globalThis.fetch = originalFetch;
	}
});

test("schedules five-minute polling and clears the interval on shutdown", async () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const handle = { unref() {} };
	let intervalCallback;
	let intervalDelay;
	let clearedHandle;
	let harness;
	globalThis.setInterval = (callback, delay) => {
		intervalCallback = callback;
		intervalDelay = delay;
		return handle;
	};
	globalThis.clearInterval = (value) => { clearedHandle = value; };
	try {
		harness = await loadQuotaExtension({
			auth: { "kimi-coding": "kimi-secret" },
			fetchImpl: async () => jsonResponse({ usage: { limit: 100, remaining: 50 } }),
		});
		await harness.hooks.get("session_start")?.({}, harness.ctx);
		await waitFor(() => harness.statuses.get("quota") === "Kimi wk 50%");
		assert.equal(intervalDelay, 300_000);
		assert.equal(harness.fetchCalls.length, 1);

		intervalCallback();
		await waitFor(() => harness.fetchCalls.length === 2);
		await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
		assert.equal(clearedHandle, handle);
		harness = undefined;
	} finally {
		if (harness) await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test("shutdown aborts polling and prevents late status updates", async () => {
	const response = deferred();
	const harness = await loadQuotaExtension({
		auth: { "kimi-coding": "kimi-secret" },
		fetchImpl: async () => response.promise,
	});

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.fetchCalls.length === 1);
	const signal = harness.fetchCalls[0].options.signal;
	assert.equal(signal.aborted, false);

	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
	assert.equal(signal.aborted, true);
	assert.equal(harness.statuses.get("quota"), undefined);

	response.resolve(jsonResponse({ usage: { limit: 100, remaining: 10 } }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(harness.statuses.get("quota"), undefined);
});

test("omits unconfigured providers without making quota requests", async () => {
	const harness = await loadQuotaExtension();

	await harness.hooks.get("session_start")?.({}, harness.ctx);
	await waitFor(() => harness.statuses.has("quota"));
	assert.equal(harness.statuses.get("quota"), undefined);
	assert.equal(harness.fetchCalls.length, 0);

	await harness.commands.get("quota").handler("", harness.ctx);
	assert.match(harness.notifications.at(-1).message, /No OpenAI Codex or Kimi Code credentials/);
	await harness.hooks.get("session_shutdown")?.({}, harness.ctx);
});
