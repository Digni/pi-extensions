import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

type AutoCompactConfig = {
	enabled?: boolean;
	thresholdPercent?: number;
	customInstructions?: string;
};

type ConfigSource = "default" | "global" | "session";

type LatestUsage = {
	percent: number | null;
	tokens: number | null;
	contextWindow: number;
};

type BuiltInCompactionSettings = {
	enabled: boolean;
	reserveTokens: number;
};

const DEFAULT_CONFIG: Required<AutoCompactConfig> = {
	enabled: true,
	thresholdPercent: 70,
	customInstructions: "",
};

const MIN_THRESHOLD_PERCENT = 10;
const MAX_THRESHOLD_PERCENT = 95;
const STATE_ENTRY = "auto-compact-state";

function expandHomePrefix(value: string): string {
	if (value === "~") return process.env.HOME ?? value;
	if (value.startsWith("~/")) return path.join(process.env.HOME ?? ".", value.slice(2));
	return value;
}

const AGENT_DIR = expandHomePrefix(process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? ".", ".pi", "agent"));
const GLOBAL_CONFIG_PATH = path.join(AGENT_DIR, "extensions", "auto-compact", "config.json");

function normalizeThreshold(value: unknown): number | undefined {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
	if (!Number.isFinite(numeric)) return undefined;
	if (numeric < MIN_THRESHOLD_PERCENT || numeric > MAX_THRESHOLD_PERCENT) return undefined;
	return numeric;
}

function normalizeConfig(value: unknown, warn?: (message: string) => void): AutoCompactConfig {
	if (!value || typeof value !== "object") return {};
	const raw = value as Record<string, unknown>;
	const config: AutoCompactConfig = {};

	if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;

	if ("thresholdPercent" in raw) {
		const threshold = normalizeThreshold(raw.thresholdPercent);
		if (threshold !== undefined) {
			config.thresholdPercent = threshold;
		} else {
			warn?.(`Ignoring invalid thresholdPercent=${JSON.stringify(raw.thresholdPercent)}; expected ${MIN_THRESHOLD_PERCENT}-${MAX_THRESHOLD_PERCENT}`);
		}
	}

	if (typeof raw.customInstructions === "string") config.customInstructions = raw.customInstructions;
	return config;
}

function readConfig(filePath: string): AutoCompactConfig {
	try {
		return normalizeConfig(JSON.parse(fs.readFileSync(filePath, "utf8")), (message) => {
			console.warn(`[auto-compact] ${filePath}: ${message}`);
		});
	} catch (error: any) {
		if (error?.code !== "ENOENT") {
			console.warn(`[auto-compact] Failed to read ${filePath}: ${error?.message ?? error}`);
		}
		return {};
	}
}

function writeConfig(filePath: string, patch: AutoCompactConfig) {
	const current = readConfig(filePath);
	const next = { ...current, ...patch };
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function formatPercent(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function formatUsage(usage: LatestUsage | undefined): string {
	if (!usage) return "usage unknown";
	if (usage.percent === null || usage.tokens === null) return `usage unknown/${usage.contextWindow.toLocaleString()}`;
	return `${formatPercent(usage.percent)}% (${usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens)`;
}

function getBranchEntries(ctx: ExtensionContext): any[] {
	const sessionManager = ctx.sessionManager as any;
	if (typeof sessionManager.getBranch === "function") return sessionManager.getBranch();
	if (typeof sessionManager.getEntries === "function") return sessionManager.getEntries();
	return [];
}

function readJsonFile(filePath: string): any | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

function getBuiltInCompactionSettings(cwd: string): BuiltInCompactionSettings {
	const globalSettingsPath = path.join(AGENT_DIR, "settings.json");
	const projectSettingsPath = path.join(path.resolve(cwd), ".pi", "settings.json");
	const globalCompaction = readJsonFile(globalSettingsPath)?.compaction ?? {};
	const projectCompaction = readJsonFile(projectSettingsPath)?.compaction ?? {};
	const merged = { ...globalCompaction, ...projectCompaction } as Record<string, unknown>;
	return {
		enabled: typeof merged.enabled === "boolean" ? merged.enabled : true,
		reserveTokens: typeof merged.reserveTokens === "number" && Number.isFinite(merged.reserveTokens) ? merged.reserveTokens : 16_384,
	};
}

function shouldDeferToBuiltInCompaction(ctx: ExtensionContext, usage: LatestUsage): boolean {
	if (usage.tokens === null) return false;
	const builtIn = getBuiltInCompactionSettings(ctx.cwd);
	if (!builtIn.enabled) return false;
	return usage.tokens > usage.contextWindow - builtIn.reserveTokens;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

export default function (pi: ExtensionAPI) {
	let enabled = DEFAULT_CONFIG.enabled;
	let thresholdPercent = DEFAULT_CONFIG.thresholdPercent;
	let customInstructions = DEFAULT_CONFIG.customInstructions;
	let enabledSource: ConfigSource = "default";
	let thresholdSource: ConfigSource = "default";
	let customInstructionsSource: ConfigSource = "default";
	let sessionOverride: AutoCompactConfig = {};
	let latestUsage: LatestUsage | undefined;
	let previousPercent: number | undefined = undefined;
	let isCompacting = false;
	let pendingCompact = false;

	function applyConfig(config: AutoCompactConfig, source: ConfigSource) {
		if (typeof config.enabled === "boolean") {
			enabled = config.enabled;
			enabledSource = source;
		}
		if (typeof config.thresholdPercent === "number") {
			thresholdPercent = config.thresholdPercent;
			thresholdSource = source;
		}
		if (typeof config.customInstructions === "string") {
			customInstructions = config.customInstructions;
			customInstructionsSource = source;
		}
	}

	function reloadConfig(ctx: ExtensionContext) {
		enabled = DEFAULT_CONFIG.enabled;
		thresholdPercent = DEFAULT_CONFIG.thresholdPercent;
		customInstructions = DEFAULT_CONFIG.customInstructions;
		enabledSource = "default";
		thresholdSource = "default";
		customInstructionsSource = "default";
		sessionOverride = {};

		applyConfig(readConfig(GLOBAL_CONFIG_PATH), "global");

		for (const entry of getBranchEntries(ctx)) {
			if (entry?.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
				const state = normalizeConfig(entry.data);
				sessionOverride = { ...sessionOverride, ...state };
				applyConfig(state, "session");
			}
		}

		resetBaseline(ctx);
	}

	function resetBaseline(ctx: ExtensionContext) {
		const usage = ctx.getContextUsage();
		latestUsage = usage
			? { percent: usage.percent, tokens: usage.tokens, contextWindow: usage.contextWindow }
			: undefined;
		previousPercent = usage?.percent ?? 0;
		pendingCompact = false;
	}

	function persistSessionOverride() {
		pi.appendEntry(STATE_ENTRY, { ...sessionOverride, timestamp: Date.now() });
	}

	function statusText() {
		const enabledText = enabled ? `${formatPercent(thresholdPercent)}%` : "off";
		const sourceText = enabledSource === thresholdSource ? thresholdSource : `enabled:${enabledSource}, threshold:${thresholdSource}`;
		const compactingText = isCompacting ? ", compacting" : "";
		const pendingText = pendingCompact ? ", pending" : "";
		return `🧹 compact:${enabledText} (${sourceText}, ${formatUsage(latestUsage)}${compactingText}${pendingText})`;
	}

	function setStatus(ctx: ExtensionContext) {
		if (ctx.hasUI) ctx.ui.setStatus("auto-compact", statusText());
	}

	function statusDetails() {
		const instructionsText = customInstructions.trim()
			? `customInstructions=${JSON.stringify(customInstructions)} (${customInstructionsSource})`
			: `customInstructions=<none> (${customInstructionsSource})`;
		return [
			`Auto compact: ${enabled ? "enabled" : "disabled"} (${enabledSource})`,
			`Threshold: ${formatPercent(thresholdPercent)}% (${thresholdSource})`,
			`Latest usage: ${formatUsage(latestUsage)}`,
			instructionsText,
			`Global config: ${GLOBAL_CONFIG_PATH}`,
		].join("\n");
	}

	function triggerCompaction(ctx: ExtensionContext, instructions?: string) {
		if (isCompacting) {
			notify(ctx, "Auto compact is already compacting", "warning");
			return;
		}

		pendingCompact = false;
		isCompacting = true;
		setStatus(ctx);
		notify(ctx, "Auto compact: compaction started", "info");

		ctx.compact({
			customInstructions: instructions?.trim() || customInstructions.trim() || undefined,
			onComplete: () => {
				isCompacting = false;
				previousPercent = undefined;
				notify(ctx, "Auto compact: compaction completed", "info");
				setStatus(ctx);
			},
			onError: (error) => {
				isCompacting = false;
				previousPercent = undefined;
				notify(ctx, `Auto compact failed: ${error.message}`, "error");
				setStatus(ctx);
			},
		});
	}

	function setSessionThreshold(ctx: ExtensionContext, value: unknown) {
		const threshold = normalizeThreshold(value);
		if (threshold === undefined) {
			notify(
				ctx,
				`Usage: /auto-compact <${MIN_THRESHOLD_PERCENT}-${MAX_THRESHOLD_PERCENT}> (example: /auto-compact 70)`,
				"warning",
			);
			return;
		}
		sessionOverride = { ...sessionOverride, thresholdPercent: threshold };
		thresholdPercent = threshold;
		thresholdSource = "session";
		resetBaseline(ctx);
		persistSessionOverride();
		setStatus(ctx);
		notify(ctx, `Auto compact threshold set to ${formatPercent(threshold)}% for this session`, "info");
	}

	function setSessionEnabled(ctx: ExtensionContext, nextEnabled: boolean) {
		sessionOverride = { ...sessionOverride, enabled: nextEnabled };
		enabled = nextEnabled;
		enabledSource = "session";
		resetBaseline(ctx);
		persistSessionOverride();
		setStatus(ctx);
		notify(ctx, `Auto compact ${nextEnabled ? "enabled" : "disabled"} for this session`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig(ctx);
		setStatus(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		previousPercent = undefined;
		isCompacting = false;
		pendingCompact = false;
		latestUsage = undefined;
		setStatus(ctx);
	});

	function updateUsageAndDetectCrossing(ctx: ExtensionContext): boolean {
		const usage = ctx.getContextUsage();
		if (!usage) {
			latestUsage = undefined;
			previousPercent = undefined;
			setStatus(ctx);
			return false;
		}

		latestUsage = {
			percent: usage.percent,
			tokens: usage.tokens,
			contextWindow: usage.contextWindow,
		};
		setStatus(ctx);

		const currentPercent = usage.percent;
		if (currentPercent === null) {
			previousPercent = undefined;
			return false;
		}

		const crossedThreshold = previousPercent !== undefined && previousPercent < thresholdPercent && currentPercent >= thresholdPercent;
		previousPercent = currentPercent;
		return crossedThreshold;
	}

	pi.on("turn_end", async (_event, ctx) => {
		const crossedThreshold = updateUsageAndDetectCrossing(ctx);

		if (!enabled || isCompacting || pendingCompact || !crossedThreshold || !latestUsage) return;
		if (shouldDeferToBuiltInCompaction(ctx, latestUsage)) {
			notify(ctx, "Auto compact: deferring to pi's built-in compaction near the context limit", "info");
			return;
		}

		pendingCompact = true;
		setStatus(ctx);
		notify(ctx, "Auto compact: threshold crossed; will compact after this prompt finishes", "info");
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingCompact || isCompacting || !enabled) return;
		if (latestUsage && shouldDeferToBuiltInCompaction(ctx, latestUsage)) {
			pendingCompact = false;
			setStatus(ctx);
			notify(ctx, "Auto compact: deferring to pi's built-in compaction near the context limit", "info");
			return;
		}
		triggerCompaction(ctx);
	});

	pi.registerCommand("auto-compact", {
		description:
			"Show or configure percentage-based auto-compaction: /auto-compact [status|<percent>|global <percent>|on|off|now [instructions]]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				notify(ctx, statusDetails(), "info");
				setStatus(ctx);
				return;
			}

			const [command, ...rest] = trimmed.split(/\s+/);
			if (command === "on" || command === "off") {
				setSessionEnabled(ctx, command === "on");
				return;
			}

			if (command === "now") {
				triggerCompaction(ctx, rest.join(" ").trim());
				return;
			}

			if (command === "global") {
				const threshold = normalizeThreshold(rest[0]);
				if (threshold === undefined) {
					notify(ctx, `Usage: /auto-compact global <${MIN_THRESHOLD_PERCENT}-${MAX_THRESHOLD_PERCENT}>`, "warning");
					return;
				}
				try {
					writeConfig(GLOBAL_CONFIG_PATH, { thresholdPercent: threshold });
					reloadConfig(ctx);
					setStatus(ctx);
					const activeSuffix = thresholdSource === "session" ? ` Current session still uses session override ${formatPercent(thresholdPercent)}%.` : "";
					notify(ctx, `Global auto compact threshold set to ${formatPercent(threshold)}%.${activeSuffix}`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					notify(ctx, `Failed to write auto compact config: ${message}`, "error");
				}
				return;
			}

			if (normalizeThreshold(command) !== undefined) {
				setSessionThreshold(ctx, command);
				return;
			}

			notify(
				ctx,
				"Usage: /auto-compact [status|<percent>|global <percent>|on|off|now [instructions]]",
				"warning",
			);
		},
	});
}
