import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadSafetyGate, makeModel } from "./helpers/safety-gate-harness.mjs";

test("safety review model defaults are auto", async () => {
	const { flags } = await loadSafetyGate([]);
	assert.equal(flags.get("safety-review-model")?.default, "auto");
	assert.equal(flags.get("safety-review-fallback-model")?.default, "auto");
});

test("auto ranking prefers fast terms, OpenAI Codex, then lower cost and larger budgets", async () => {
	const models = [
		makeModel("slow", "giant-pro", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 128_000, contextWindow: 1_000_000 }),
		makeModel("cheap", "plain", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 16_000, contextWindow: 128_000 }),
		makeModel("expensive", "plain", { cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, maxTokens: 128_000, contextWindow: 1_000_000 }),
		makeModel("openai-codex", "gpt-5.3-codex-spark", { cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, maxTokens: 64_000, contextWindow: 272_000 }),
		makeModel("github-copilot", "gpt-5-mini", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, maxTokens: 128_000, contextWindow: 1_000_000 }),
	];
	const { commands, notifications, ctx } = await loadSafetyGate(models);
	await commands.get("safety").handler("status", ctx);
	const status = notifications.at(-1).message;
	assert.match(status, /reviewModel=auto .*resolved openai-codex\/gpt-5\.3-codex-spark/);
	assert.match(status, /fallbackReviewModel=auto .*resolved github-copilot\/gpt-5-mini/);

	await commands.get("safety").handler("models", ctx);
	const list = notifications.at(-1).message;
	assert.ok(list.indexOf("cheap/plain") < list.indexOf("expensive/plain"), list);
});

test("removed models are excluded from automatic resolution and listings", async () => {
	const models = [
		makeModel("openai-codex", "gpt-5.4-mini", { maxTokens: 128_000, contextWindow: 272_000 }),
		makeModel("openai-codex", "gpt-5.3-codex-spark", { maxTokens: 128_000, contextWindow: 128_000 }),
		makeModel("other", "reliable-flash", { maxTokens: 128_000, contextWindow: 1_000_000 }),
	];
	const { commands, notifications, selections, ctx } = await loadSafetyGate(models);
	await commands.get("safety").handler("status", ctx);
	const status = notifications.at(-1).message;
	assert.match(status, /reviewModel=auto .*resolved openai-codex\/gpt-5\.3-codex-spark/);
	assert.match(status, /fallbackReviewModel=auto .*resolved other\/reliable-flash/);
	assert.match(status, /availableModels=2/);

	await commands.get("safety").handler("models", ctx);
	assert.doesNotMatch(notifications.at(-1).message, /gpt-5\.4-mini/);

	await commands.get("safety").handler("model", ctx);
	await commands.get("safety").handler("fallback", ctx);
	assert.equal(selections.length, 2);
	for (const selection of selections) {
		assert.doesNotMatch(selection.options.join("\n"), /gpt-5\.4-mini/);
	}
});

test("auto ranking applies the OpenAI Codex preference only among fast-name models", async () => {
	const models = [
		makeModel("openai-codex", "gpt-5.5", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		makeModel("other", "reliable-flash", { cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }),
	];
	const { commands, notifications, ctx } = await loadSafetyGate(models);
	await commands.get("safety").handler("status", ctx);
	assert.match(notifications.at(-1).message, /reviewModel=auto .*resolved other\/reliable-flash/);
});

test("auto ranking excludes extension-only providers", async () => {
	const models = [
		makeModel("extension-fast", "claude-haiku-4-5"),
		makeModel("builtin-fast", "deepseek-v4-flash", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
		makeModel("builtin-fast", "gpt-5.5-mini", { cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } }),
	];
	const { commands, notifications, ctx } = await loadSafetyGate(models, { registeredProviderIds: ["extension-fast"] });
	await commands.get("safety").handler("status", ctx);
	const status = notifications.at(-1).message;
	assert.match(status, /reviewModel=auto .*resolved builtin-fast\/deepseek-v4-flash/);
	assert.match(status, /fallbackReviewModel=auto .*resolved builtin-fast\/gpt-5\.5-mini/);
	assert.doesNotMatch(status, /resolved extension-fast\/claude-haiku-4-5/);
});

test("auto ranking remains available when provider-origin metadata is unsupported", async () => {
	const { commands, notifications, ctx } = await loadSafetyGate([makeModel("builtin", "fast-mini")], {
		exposeRegisteredProviderIds: false,
	});
	await commands.get("safety").handler("status", ctx);
	assert.match(notifications.at(-1).message, /reviewModel=auto \([^)]*resolved builtin\/fast-mini\)/);
});

test("auto ranking matches fast terms at token boundaries", async () => {
	const models = [
		makeModel("cheap", "minimax-m3", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 128_000, contextWindow: 1_000_000 }),
		makeModel("other", "reliable-mini", { cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }),
	];
	const { commands, notifications, ctx } = await loadSafetyGate(models);
	await commands.get("safety").handler("status", ctx);
	assert.match(notifications.at(-1).message, /reviewModel=auto \([^)]*resolved other\/reliable-mini\)/);
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

test("removed models in existing config fall back to auto", async () => {
	const { commands, notifications, ctx } = await loadSafetyGate([
		makeModel("openai-codex", "gpt-5.3-codex-spark"),
		makeModel("other", "reliable-flash"),
	], {
		config: {
			reviewModel: "openai-codex/gpt-5.4-mini",
			fallbackReviewModel: "openai-codex/gpt-5.4-mini",
		},
	});
	await commands.get("safety").handler("status", ctx);
	const status = notifications.at(-1).message;
	assert.match(status, /reviewModel=auto \(default, resolved openai-codex\/gpt-5\.3-codex-spark\)/);
	assert.match(status, /fallbackReviewModel=auto \(default, resolved other\/reliable-flash\)/);
});

test("removed models in persisted session state fall back to auto", async () => {
	const { commands, notifications, ctx } = await loadSafetyGate([
		makeModel("openai-codex", "gpt-5.3-codex-spark"),
		makeModel("other", "reliable-flash"),
	], {
		sessionEntries: [{
			type: "custom",
			customType: "safety-gate-state",
			data: {
				reviewModel: "openai-codex/gpt-5.4-mini",
				fallbackReviewModel: "openai-codex/gpt-5.4-mini",
			},
		}],
	});
	await commands.get("safety").handler("status", ctx);
	const status = notifications.at(-1).message;
	assert.match(status, /reviewModel=auto \(default, resolved openai-codex\/gpt-5\.3-codex-spark\)/);
	assert.match(status, /fallbackReviewModel=auto \(default, resolved other\/reliable-flash\)/);
});

test("removed models in CLI flags fall back to auto", async () => {
	const originalArgv = process.argv.slice();
	let loaded;
	try {
		process.argv.push(
			"--safety-review-model",
			"openai-codex/gpt-5.4-mini",
			"--safety-review-fallback-model=openai-codex/gpt-5.4-mini",
		);
		loaded = await loadSafetyGate([
			makeModel("openai-codex", "gpt-5.3-codex-spark"),
			makeModel("other", "reliable-flash"),
		]);
	} finally {
		process.argv.splice(0, process.argv.length, ...originalArgv);
	}

	const { commands, notifications, ctx } = loaded;
	await commands.get("safety").handler("status", ctx);
	const status = notifications.at(-1).message;
	assert.match(status, /reviewModel=auto \(default, resolved openai-codex\/gpt-5\.3-codex-spark\)/);
	assert.match(status, /fallbackReviewModel=auto \(default, resolved other\/reliable-flash\)/);
});

test("removed models cannot be selected for the session", async () => {
	const { commands, appended, notifications, ctx } = await loadSafetyGate([
		makeModel("openai-codex", "gpt-5.3-codex-spark"),
	]);
	await commands.get("safety").handler("model openai-codex/gpt-5.4-mini", ctx);
	assert.equal(appended.length, 0);
	assert.match(notifications.at(-1).message, /gpt-5\.4-mini is no longer available/);
	assert.equal(notifications.at(-1).level, "warning");
});

test("removed models cannot be persisted in global or project config", async () => {
	const { commands, notifications, ctx, home } = await loadSafetyGate([
		makeModel("openai-codex", "gpt-5.3-codex-spark"),
	]);
	await commands.get("safety").handler("global model openai-codex/gpt-5.4-mini", ctx);
	assert.match(notifications.at(-1).message, /gpt-5\.4-mini is no longer available/);
	const globalConfig = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "extensions", "safety-gate", "config.json"), "utf8"));
	assert.ok(!("reviewModel" in globalConfig));

	await commands.get("safety").handler("project fallback openai-codex/gpt-5.4-mini", ctx);
	assert.match(notifications.at(-1).message, /gpt-5\.4-mini is no longer available/);
	assert.equal(fs.existsSync(path.join(ctx.cwd, ".pi", "safety-gate.json")), false);
});
