import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadGoalExtension({ entries = [], hasUI = true, confirmResult = true, pendingMessages = false, idle = true } = {}) {
	const moduleUrl = new URL(`../extensions/goal/index.ts?test=${Date.now()}-${Math.random()}`, import.meta.url);
	const { default: extension } = await import(moduleUrl.href);

	const hooks = new Map();
	const commands = new Map();
	const tools = new Map();
	const appended = [];
	const sentUserMessages = [];
	const notifications = [];
	const statuses = new Map();
	const confirmations = [];

	extension({
		on(name, cb) { hooks.set(name, cb); },
		registerCommand(name, spec) { commands.set(name, spec); },
		registerTool(spec) { tools.set(spec.name, spec); },
		appendEntry(type, data) {
			appended.push({ type, data });
			entries.push({ type: "custom", customType: type, data });
		},
		sendUserMessage(content, options) { sentUserMessages.push({ content, options }); },
	});

	const ctx = {
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), "goal-cwd-")),
		hasUI,
		ui: {
			setStatus(key, value) { statuses.set(key, value); },
			notify(message, level) { notifications.push({ message, level }); },
			async confirm(title, message) {
				confirmations.push({ title, message });
				return confirmResult;
			},
		},
		sessionManager: {
			getEntries() { return entries; },
			getBranch() { return entries; },
		},
		hasPendingMessages() { return pendingMessages; },
		isIdle() { return idle; },
	};

	await hooks.get("session_start")?.({}, ctx);
	return { hooks, commands, tools, appended, sentUserMessages, notifications, statuses, confirmations, ctx, entries };
}

test("/goal sets a persisted goal and kicks off the agent", async () => {
	const { commands, appended, sentUserMessages, statuses, notifications, ctx } = await loadGoalExtension();

	await commands.get("goal").handler("write useful docs", ctx);

	assert.equal(appended.at(-1).type, "goal-state");
	assert.equal(appended.at(-1).data.objective, "write useful docs");
	assert.equal(appended.at(-1).data.status, "active");
	assert.equal(appended.at(-1).data.turnsUsed, 0);
	assert.equal(appended.at(-1).data.maxTurns, 8);
	assert.match(statuses.get("goal"), /goal:active/);
	assert.match(notifications.at(-1).message, /Goal set/);
	assert.equal(sentUserMessages.length, 1);
	assert.match(sentUserMessages[0].content, /write useful docs/);
});

test("goal state is reconstructed on session start", async () => {
	const entries = [{
		type: "custom",
		customType: "goal-state",
		data: { objective: "ship the feature", status: "active", createdAt: 1, updatedAt: 2, turnsUsed: 3, maxTurns: 8 },
	}];
	const { commands, notifications, statuses, ctx } = await loadGoalExtension({ entries });

	await commands.get("goal").handler("status", ctx);

	assert.match(notifications.at(-1).message, /Objective: ship the feature/);
	assert.match(notifications.at(-1).message, /Turns: 3\/8/);
	assert.match(statuses.get("goal"), /goal:active 3\/8/);
});

test("status line is hidden when there is no active goal", async () => {
	const noGoal = await loadGoalExtension();
	assert.equal(noGoal.statuses.get("goal"), undefined);

	const pausedEntries = [{
		type: "custom",
		customType: "goal-state",
		data: { objective: "ship the feature", status: "paused", createdAt: 1, updatedAt: 2, turnsUsed: 3, maxTurns: 8 },
	}];
	const paused = await loadGoalExtension({ entries: pausedEntries });
	assert.equal(paused.statuses.get("goal"), undefined);
});

test("/goal controls pause, resume, complete, and clear the goal", async () => {
	const { commands, appended, sentUserMessages, statuses, notifications, ctx } = await loadGoalExtension();
	await commands.get("goal").handler("finish migration", ctx);
	sentUserMessages.length = 0;

	await commands.get("goal").handler("pause", ctx);
	assert.equal(appended.at(-1).data.status, "paused");
	assert.equal(statuses.get("goal"), undefined);
	assert.equal(sentUserMessages.length, 0);

	await commands.get("goal").handler("resume", ctx);
	assert.equal(appended.at(-1).data.status, "active");
	assert.equal(sentUserMessages.length, 1);
	assert.match(sentUserMessages.at(-1).content, /Continue pursuing/);
	assert.match(statuses.get("goal"), /goal:active/);

	await commands.get("goal").handler("complete", ctx);
	assert.equal(appended.at(-1).data.status, "complete");
	assert.equal(statuses.get("goal"), undefined);

	await commands.get("goal").handler("clear", ctx);
	assert.equal(appended.at(-1).data.status, "cleared");
	assert.equal(statuses.get("goal"), undefined);
	assert.match(notifications.at(-1).message, /Goal cleared/);
});

test("setting a new goal asks before replacing an active goal", async () => {
	const { commands, appended, confirmations, ctx } = await loadGoalExtension({ confirmResult: false });
	await commands.get("goal").handler("first goal", ctx);

	await commands.get("goal").handler("second goal", ctx);

	assert.equal(confirmations.length, 1);
	assert.equal(appended.at(-1).data.objective, "first goal");
});

test("/goal resume does not send a continuation while the agent is busy", async () => {
	const entries = [{
		type: "custom",
		customType: "goal-state",
		data: { objective: "finish migration", status: "paused", createdAt: 1, updatedAt: 2, turnsUsed: 1, maxTurns: 8 },
	}];
	const { commands, appended, sentUserMessages, ctx } = await loadGoalExtension({ entries, idle: false });

	await commands.get("goal").handler("resume", ctx);

	assert.equal(appended.at(-1).data.status, "active");
	assert.equal(sentUserMessages.length, 0);
});

test("goal tools expose status and let the agent mark an active goal complete", async () => {
	const { commands, tools, appended, ctx } = await loadGoalExtension();
	await commands.get("goal").handler("publish release notes", ctx);

	const statusResult = await tools.get("goal_status").execute("status-1", {}, undefined, undefined, ctx);
	assert.match(statusResult.content[0].text, /Objective: publish release notes/);
	assert.equal(statusResult.details.goal.status, "active");

	const completeResult = await tools.get("goal_complete").execute("complete-1", {}, undefined, undefined, ctx);
	assert.match(completeResult.content[0].text, /Goal complete: publish release notes/);
	assert.equal(completeResult.details.goal.status, "complete");
	assert.equal(appended.at(-1).data.status, "complete");
});

test("goal_complete is a no-op when the goal is paused", async () => {
	const entries = [{
		type: "custom",
		customType: "goal-state",
		data: { objective: "publish release notes", status: "paused", createdAt: 1, updatedAt: 2, turnsUsed: 1, maxTurns: 8 },
	}];
	const { tools, appended, ctx } = await loadGoalExtension({ entries });

	const result = await tools.get("goal_complete").execute("complete-1", {}, undefined, undefined, ctx);

	assert.match(result.content[0].text, /active goal/);
	assert.equal(result.details.goal.status, "paused");
	assert.equal(appended.length, 0);
});

test("active goals inject steering instructions into the system prompt", async () => {
	const { commands, hooks, ctx } = await loadGoalExtension();
	await commands.get("goal").handler("stabilize tests", ctx);

	const result = await hooks.get("before_agent_start")({ systemPrompt: "base", prompt: "continue" }, ctx);

	assert.match(result.systemPrompt, /Active persistent goal/);
	assert.match(result.systemPrompt, /stabilize tests/);
	assert.match(result.systemPrompt, /goal_complete/);

	await commands.get("goal").handler("pause", ctx);
	const pausedResult = await hooks.get("before_agent_start")({ systemPrompt: "base", prompt: "continue" }, ctx);
	assert.equal(pausedResult, undefined);
});

test("agent_end auto-continues active goals with a bounded follow-up", async () => {
	const entries = [{
		type: "custom",
		customType: "goal-state",
		data: { objective: "finish audit", status: "active", createdAt: 1, updatedAt: 2, turnsUsed: 2, maxTurns: 8 },
	}];
	const { hooks, appended, sentUserMessages, statuses, ctx } = await loadGoalExtension({ entries });

	await hooks.get("agent_end")({}, ctx);

	assert.equal(appended.at(-1).data.turnsUsed, 3);
	assert.equal(appended.at(-1).data.status, "active");
	assert.equal(sentUserMessages.length, 1);
	assert.equal(sentUserMessages[0].options.deliverAs, "followUp");
	assert.match(sentUserMessages[0].content, /Continue pursuing/);
	assert.match(statuses.get("goal"), /goal:active 3\/8/);
});

test("agent_end does not auto-continue inactive goals or when pending messages exist", async () => {
	const pausedEntries = [{
		type: "custom",
		customType: "goal-state",
		data: { objective: "finish audit", status: "paused", createdAt: 1, updatedAt: 2, turnsUsed: 2, maxTurns: 8 },
	}];
	const paused = await loadGoalExtension({ entries: pausedEntries });
	await paused.hooks.get("agent_end")({}, paused.ctx);
	assert.equal(paused.sentUserMessages.length, 0);

	const pendingEntries = [{
		type: "custom",
		customType: "goal-state",
		data: { objective: "finish audit", status: "active", createdAt: 1, updatedAt: 2, turnsUsed: 2, maxTurns: 8 },
	}];
	const pending = await loadGoalExtension({ entries: pendingEntries, pendingMessages: true });
	await pending.hooks.get("agent_end")({}, pending.ctx);
	assert.equal(pending.sentUserMessages.length, 0);
});

test("agent_end pauses instead of continuing after the safety cap", async () => {
	const entries = [{
		type: "custom",
		customType: "goal-state",
		data: { objective: "finish audit", status: "active", createdAt: 1, updatedAt: 2, turnsUsed: 8, maxTurns: 8 },
	}];
	const { hooks, appended, sentUserMessages, notifications, statuses, ctx } = await loadGoalExtension({ entries });

	await hooks.get("agent_end")({}, ctx);

	assert.equal(sentUserMessages.length, 0);
	assert.equal(appended.at(-1).data.status, "paused");
	assert.match(appended.at(-1).data.lastReason, /continuation cap/);
	assert.match(notifications.at(-1).message, /continuation cap/);
	assert.equal(statuses.get("goal"), undefined);
});
