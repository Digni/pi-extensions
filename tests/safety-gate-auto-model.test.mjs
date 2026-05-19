import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function makeModel(provider, id, options = {}) {
	return {
		provider,
		id,
		name: options.name ?? id,
		cost: options.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 128_000,
		maxTokens: options.maxTokens ?? 16_000,
	};
}

async function loadSafetyGate(models, { hasUI = true } = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "safety-home-"));
	process.env.HOME = home;
	const configDir = path.join(home, ".pi", "agent", "extensions", "safety-gate");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ mode: "auto" }));

	const moduleUrl = new URL(`../extensions/safety-gate/index.ts?test=${Date.now()}-${Math.random()}`, import.meta.url);
	const { default: extension } = await import(moduleUrl.href);

	const hooks = new Map();
	const commands = new Map();
	const flags = new Map();
	const appended = [];
	extension({
		registerFlag(name, spec) { flags.set(name, spec); },
		getFlag() { return undefined; },
		appendEntry(type, data) { appended.push({ type, data }); },
		on(name, cb) { hooks.set(name, cb); },
		registerCommand(name, spec) { commands.set(name, spec); },
	});

	const notifications = [];
	const ctx = {
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), "safety-cwd-")),
		hasUI,
		ui: {
			setStatus() {},
			notify(message, level) { notifications.push({ message, level }); },
			async select(_title, options) { return options[0]; },
			async confirm() { return false; },
			async input() { return ""; },
		},
		sessionManager: { getEntries() { return []; } },
		modelRegistry: { getAvailable() { return models; } },
		signal: undefined,
	};

	await hooks.get("session_start")({}, ctx);
	return { hooks, commands, flags, appended, notifications, ctx };
}

test("safety review model defaults are auto", async () => {
	const { flags } = await loadSafetyGate([]);
	assert.equal(flags.get("safety-review-model")?.default, "auto");
	assert.equal(flags.get("safety-review-fallback-model")?.default, "auto");
});

test("auto ranking prefers fast terms, then lower cost, then larger budgets", async () => {
	const models = [
		makeModel("slow", "giant-pro", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 128_000, contextWindow: 1_000_000 }),
		makeModel("cheap", "plain", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 16_000, contextWindow: 128_000 }),
		makeModel("expensive", "plain", { cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, maxTokens: 128_000, contextWindow: 1_000_000 }),
		makeModel("openai-codex", "gpt-5.3-codex-spark", { cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, maxTokens: 64_000, contextWindow: 272_000 }),
		makeModel("github-copilot", "gpt-5-mini", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 64_000, contextWindow: 264_000 }),
	];
	const { commands, notifications, ctx } = await loadSafetyGate(models);
	await commands.get("safety").handler("status", ctx);
	const status = notifications.at(-1).message;
	assert.match(status, /reviewModel=auto .*resolved github-copilot\/gpt-5-mini/);
	assert.match(status, /fallbackReviewModel=auto .*resolved openai-codex\/gpt-5\.3-codex-spark/);

	await commands.get("safety").handler("models", ctx);
	const list = notifications.at(-1).message;
	assert.ok(list.indexOf("cheap/plain") < list.indexOf("expensive/plain"), list);
});

test("auto ranking uses larger budgets only after fast term and cost ties", async () => {
	const models = [
		makeModel("fast", "same-cost-mini-small-budget", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 16_000, contextWindow: 128_000 }),
		makeModel("fast", "same-cost-mini-large-budget", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 64_000, contextWindow: 264_000 }),
	];
	const { commands, notifications, ctx } = await loadSafetyGate(models);
	await commands.get("safety").handler("status", ctx);
	assert.match(notifications.at(-1).message, /reviewModel=auto .*resolved fast\/same-cost-mini-large-budget/);
});

test("model commands accept auto and explicit refs", async () => {
	const { commands, appended, ctx } = await loadSafetyGate([makeModel("github-copilot", "gpt-5-mini")]);
	await commands.get("safety").handler("fallback auto", ctx);
	assert.equal(appended.at(-1).data.fallbackReviewModel, "auto");

	await commands.get("safety").handler("model github-copilot/gpt-5-mini", ctx);
	assert.equal(appended.at(-1).data.reviewModel, "github-copilot/gpt-5-mini");
});

test("no available auto model blocks without UI", async () => {
	const { hooks, ctx } = await loadSafetyGate([], { hasUI: false });
	const blocked = await hooks.get("user_bash")({ command: "rm -rf /tmp" }, ctx);
	assert.equal(blocked?.result?.exitCode, 1);
	assert.match(blocked.result.output, /no available model/);
});
