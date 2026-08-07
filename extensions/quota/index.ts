import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "quota";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const KIMI_POST_USE_REFRESH_COOLDOWN_MS = 30_000;

type QuotaWindow = {
	remainingPercent: number;
	resetAt?: number;
};

type ProviderQuota = {
	configured: boolean;
	updatedAt?: number;
	error?: string;
	fiveHour?: QuotaWindow;
	weekly?: QuotaWindow;
};

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "string" && !value.trim()) return undefined;
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(number) ? number : undefined;
}

function remainingPercent(used: unknown): number | undefined {
	const value = finiteNumber(used);
	if (value === undefined) return undefined;
	return Math.min(100, Math.max(0, 100 - value));
}

function resetAt(value: Record<string, unknown>): number | undefined {
	const resetAtSeconds = finiteNumber(value.reset_at);
	if (resetAtSeconds !== undefined && resetAtSeconds > 0) return resetAtSeconds * 1000;
	const resetAfterSeconds = finiteNumber(value.reset_after_seconds);
	if (resetAfterSeconds !== undefined && resetAfterSeconds > 0) return Date.now() + resetAfterSeconds * 1000;
	return undefined;
}

function parseCodexWindow(value: unknown): { durationSeconds?: number; quota?: QuotaWindow } {
	if (!value || typeof value !== "object") return {};
	const raw = value as Record<string, unknown>;
	const remaining = remainingPercent(raw.used_percent);
	if (remaining === undefined) return {};
	return {
		durationSeconds: finiteNumber(raw.limit_window_seconds),
		quota: { remainingPercent: remaining, resetAt: resetAt(raw) },
	};
}

function parseCodexUsage(payload: unknown): Pick<ProviderQuota, "fiveHour" | "weekly"> {
	if (!payload || typeof payload !== "object") return {};
	const rateLimit = (payload as Record<string, unknown>).rate_limit;
	if (!rateLimit || typeof rateLimit !== "object") return {};

	const result: Pick<ProviderQuota, "fiveHour" | "weekly"> = {};
	for (const value of [
		(rateLimit as Record<string, unknown>).primary_window,
		(rateLimit as Record<string, unknown>).secondary_window,
	]) {
		const parsed = parseCodexWindow(value);
		if (!parsed.quota) continue;
		if (parsed.durationSeconds === 18_000) result.fiveHour = parsed.quota;
		if (parsed.durationSeconds === 604_800) result.weekly = parsed.quota;
	}
	return result;
}

function parseCodexHeaders(headers: Record<string, string>): Pick<ProviderQuota, "fiveHour" | "weekly"> {
	const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const result: Pick<ProviderQuota, "fiveHour" | "weekly"> = {};
	for (const prefix of ["primary", "secondary"] as const) {
		const remaining = remainingPercent(normalized[`x-codex-${prefix}-used-percent`]);
		const windowMinutes = finiteNumber(normalized[`x-codex-${prefix}-window-minutes`]);
		if (remaining === undefined || windowMinutes === undefined) continue;
		const resetAfterSeconds = finiteNumber(normalized[`x-codex-${prefix}-reset-after-seconds`]);
		const quota: QuotaWindow = {
			remainingPercent: remaining,
			resetAt: resetAfterSeconds !== undefined && resetAfterSeconds > 0
				? Date.now() + resetAfterSeconds * 1000
				: undefined,
		};
		if (windowMinutes === 300) result.fiveHour = quota;
		if (windowMinutes === 10_080) result.weekly = quota;
	}
	return result;
}

function parseRemainingWindow(value: unknown): QuotaWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const limit = finiteNumber(raw.limit);
	const remaining = finiteNumber(raw.remaining);
	if (limit === undefined || limit <= 0 || remaining === undefined) return undefined;
	const resetTime = typeof raw.resetTime === "string" ? Date.parse(raw.resetTime) : NaN;
	return {
		remainingPercent: Math.min(100, Math.max(0, remaining / limit * 100)),
		resetAt: Number.isFinite(resetTime) ? resetTime : undefined,
	};
}

function isFiveHourKimiWindow(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const raw = value as Record<string, unknown>;
	const duration = finiteNumber(raw.duration);
	const unit = typeof raw.timeUnit === "string" ? raw.timeUnit.toUpperCase() : "";
	return (unit.includes("MINUTE") && duration === 300) || (unit.includes("HOUR") && duration === 5);
}

function parseKimiUsage(payload: unknown): Pick<ProviderQuota, "fiveHour" | "weekly"> {
	if (!payload || typeof payload !== "object") return {};
	const raw = payload as Record<string, unknown>;
	const result: Pick<ProviderQuota, "fiveHour" | "weekly"> = {
		weekly: parseRemainingWindow(raw.usage),
	};
	if (Array.isArray(raw.limits)) {
		for (const item of raw.limits) {
			if (!item || typeof item !== "object") continue;
			const limit = item as Record<string, unknown>;
			if (!isFiveHourKimiWindow(limit.window)) continue;
			result.fiveHour = parseRemainingWindow(limit.detail ?? limit);
			break;
		}
	}
	return result;
}

function formatPercent(value: number): string {
	return `${Math.round(value)}%`;
}

function formatProviderCompact(label: string, quota: ProviderQuota): string | undefined {
	if (!quota.configured) return undefined;
	const parts = [
		quota.fiveHour ? `5h ${formatPercent(quota.fiveHour.remainingPercent)}` : undefined,
		quota.weekly ? `wk ${formatPercent(quota.weekly.remainingPercent)}` : undefined,
	].filter(Boolean);
	return parts.length > 0 ? `${label} ${parts.join(" · ")}${quota.error ? "~" : ""}` : `${label} ?`;
}

function formatCompact(codex: ProviderQuota, kimi: ProviderQuota): string | undefined {
	const providers = [formatProviderCompact("Codex", codex), formatProviderCompact("Kimi", kimi)].filter(Boolean);
	return providers.length > 0 ? providers.join(" | ") : undefined;
}

function formatDuration(milliseconds: number): string {
	const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor(totalMinutes % (24 * 60) / 60);
	const minutes = totalMinutes % 60;
	return [days ? `${days}d` : undefined, hours ? `${hours}h` : undefined, minutes || (!days && !hours) ? `${minutes}m` : undefined]
		.filter(Boolean)
		.join(" ");
}

function formatWindowDetails(label: string, window: QuotaWindow | undefined): string | undefined {
	if (!window) return undefined;
	const reset = window.resetAt ? `, resets in ${formatDuration(window.resetAt - Date.now())}` : "";
	return `${label}: ${formatPercent(window.remainingPercent)} remaining${reset}`;
}

function formatDetails(codex: ProviderQuota, kimi: ProviderQuota): string {
	const sections: string[] = [];
	for (const [label, quota] of [["OpenAI Codex", codex], ["Kimi Code", kimi]] as const) {
		if (!quota.configured) continue;
		const lines = [
			label,
			formatWindowDetails("5h", quota.fiveHour),
			formatWindowDetails("Weekly", quota.weekly),
		].filter(Boolean) as string[];
		if (!quota.fiveHour && !quota.weekly) lines.push("Quota unavailable");
		if (quota.updatedAt) lines.push(`Updated: ${new Date(quota.updatedAt).toLocaleTimeString()}`);
		if (quota.error) lines.push(`Status: stale (${quota.error})`);
		sections.push(lines.join("\n"));
	}
	return sections.length > 0 ? sections.join("\n\n") : "No OpenAI Codex or Kimi Code credentials are configured.";
}

function getAccountId(token: string): string | undefined {
	try {
		const payloadPart = token.split(".")[1];
		if (!payloadPart) return undefined;
		const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
		const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"];
		if (!auth || typeof auth !== "object") return undefined;
		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function getFetch(ctx: ExtensionContext): typeof fetch {
	return typeof (ctx as any).fetch === "function" ? (ctx as any).fetch.bind(ctx) : fetch;
}

function requestError(error: unknown): string {
	if (!(error instanceof Error)) return "Request failed";
	if (/^HTTP \d{3}$/.test(error.message)) return error.message;
	if (error.message === "No quota windows in response") return error.message;
	if (error.name === "AbortError" || error.name === "TimeoutError") return "Request timed out";
	return "Request failed";
}

export default function (pi: ExtensionAPI) {
	let codex: ProviderQuota = { configured: false };
	let kimi: ProviderQuota = { configured: false };
	let interval: ReturnType<typeof setInterval> | undefined;
	let sessionAbort: AbortController | undefined;
	let codexRefresh: Promise<void> | undefined;
	let kimiRefresh: Promise<void> | undefined;
	let kimiRefreshQueued = false;
	let lastKimiPostUseRefreshAt = 0;
	let generation = 0;
	let codexRevision = 0;

	function setStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, formatCompact(codex, kimi));
	}

	async function runCodexRefresh(ctx: ExtensionContext, activeGeneration: number) {
		const startingRevision = codexRevision;
		let token: string | undefined;
		try {
			token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
		} catch {
			if (activeGeneration !== generation || startingRevision !== codexRevision) return;
			codex = { ...codex, configured: true, error: "Authentication failed" };
			setStatus(ctx);
			return;
		}
		if (activeGeneration !== generation || startingRevision !== codexRevision) return;
		if (!token) {
			codex = { configured: false };
			setStatus(ctx);
			return;
		}

		codex = { ...codex, configured: true };
		setStatus(ctx);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"User-Agent": "pi-quota/0.1",
		};
		const accountId = getAccountId(token);
		if (accountId) headers["ChatGPT-Account-Id"] = accountId;

		try {
			const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
			if (sessionAbort) signals.push(sessionAbort.signal);
			const response = await getFetch(ctx)(CODEX_USAGE_URL, {
				headers,
				redirect: "error",
				signal: AbortSignal.any(signals),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const parsed = parseCodexUsage(await response.json());
			if (!parsed.fiveHour && !parsed.weekly) throw new Error("No quota windows in response");
			if (activeGeneration !== generation || startingRevision !== codexRevision) return;
			codex = { configured: true, ...parsed, updatedAt: Date.now() };
			codexRevision += 1;
		} catch (error) {
			if (activeGeneration !== generation || startingRevision !== codexRevision || sessionAbort?.signal.aborted) return;
			codex = { ...codex, configured: true, error: requestError(error) };
		}
		setStatus(ctx);
	}

	async function runKimiRefresh(ctx: ExtensionContext, activeGeneration: number) {
		let token: string | undefined;
		try {
			token = await ctx.modelRegistry.getApiKeyForProvider("kimi-coding");
		} catch {
			if (activeGeneration !== generation) return;
			kimi = { ...kimi, configured: true, error: "Authentication failed" };
			setStatus(ctx);
			return;
		}
		if (activeGeneration !== generation) return;
		if (!token) {
			kimi = { configured: false };
			setStatus(ctx);
			return;
		}

		kimi = { ...kimi, configured: true };
		setStatus(ctx);
		try {
			const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
			if (sessionAbort) signals.push(sessionAbort.signal);
			const response = await getFetch(ctx)(KIMI_USAGE_URL, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					"User-Agent": "KimiCLI/1.5",
				},
				redirect: "error",
				signal: AbortSignal.any(signals),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const parsed = parseKimiUsage(await response.json());
			if (!parsed.fiveHour && !parsed.weekly) throw new Error("No quota windows in response");
			if (activeGeneration !== generation) return;
			kimi = { configured: true, ...parsed, updatedAt: Date.now() };
		} catch (error) {
			if (activeGeneration !== generation || sessionAbort?.signal.aborted) return;
			kimi = { ...kimi, configured: true, error: requestError(error) };
		}
		setStatus(ctx);
	}

	function refreshCodex(ctx: ExtensionContext, activeGeneration: number): Promise<void> {
		if (codexRefresh) return codexRefresh;
		const pending = runCodexRefresh(ctx, activeGeneration);
		codexRefresh = pending;
		void pending.then(
			() => { if (codexRefresh === pending) codexRefresh = undefined; },
			() => { if (codexRefresh === pending) codexRefresh = undefined; },
		);
		return pending;
	}

	function refreshKimi(ctx: ExtensionContext, activeGeneration: number, queueIfBusy = false): Promise<void> {
		if (kimiRefresh) {
			if (queueIfBusy) kimiRefreshQueued = true;
			return kimiRefresh;
		}
		const pending = runKimiRefresh(ctx, activeGeneration);
		kimiRefresh = pending;
		const finish = () => {
			if (kimiRefresh !== pending) return;
			kimiRefresh = undefined;
			if (!kimiRefreshQueued || activeGeneration !== generation || sessionAbort?.signal.aborted) return;
			kimiRefreshQueued = false;
			void refreshKimi(ctx, activeGeneration);
		};
		void pending.then(finish, finish);
		return pending;
	}

	async function refreshAll(ctx: ExtensionContext, activeGeneration: number): Promise<void> {
		await Promise.all([refreshCodex(ctx, activeGeneration), refreshKimi(ctx, activeGeneration)]);
	}

	function start(ctx: ExtensionContext) {
		generation += 1;
		const activeGeneration = generation;
		sessionAbort?.abort();
		sessionAbort = new AbortController();
		kimiRefreshQueued = false;
		lastKimiPostUseRefreshAt = 0;
		if (interval) clearInterval(interval);
		void refreshAll(ctx, activeGeneration);
		interval = setInterval(() => void refreshAll(ctx, activeGeneration), REFRESH_INTERVAL_MS);
		interval.unref?.();
	}

	pi.registerCommand("quota", {
		description: "Show or refresh OpenAI Codex and Kimi Code subscription quota: /quota [refresh]",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command && command !== "status" && command !== "refresh") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /quota [refresh]", "warning");
				return;
			}
			if (command === "refresh") await refreshAll(ctx, generation);
			setStatus(ctx);
			if (ctx.hasUI) ctx.ui.notify(formatDetails(codex, kimi), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		start(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		const parsed = parseCodexHeaders(event.headers);
		if (!parsed.fiveHour && !parsed.weekly) return;
		codex = {
			configured: true,
			fiveHour: parsed.fiveHour ?? codex.fiveHour,
			weekly: parsed.weekly ?? codex.weekly,
			updatedAt: Date.now(),
		};
		codexRevision += 1;
		setStatus(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui" || ctx.model?.provider !== "kimi-coding") return;
		const now = Date.now();
		if (now - lastKimiPostUseRefreshAt < KIMI_POST_USE_REFRESH_COOLDOWN_MS) return;
		lastKimiPostUseRefreshAt = now;
		void refreshKimi(ctx, generation, true);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		generation += 1;
		if (interval) clearInterval(interval);
		interval = undefined;
		sessionAbort?.abort();
		sessionAbort = undefined;
		codexRefresh = undefined;
		kimiRefresh = undefined;
		kimiRefreshQueued = false;
		lastKimiPostUseRefreshAt = 0;
		codex = { configured: false };
		kimi = { configured: false };
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
