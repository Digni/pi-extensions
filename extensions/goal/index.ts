import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type GoalStatus = "active" | "paused" | "complete" | "cleared";

type GoalState = {
	objective?: string;
	status: GoalStatus;
	createdAt?: number;
	updatedAt: number;
	turnsUsed: number;
	maxTurns: number;
	lastReason?: string;
};

const STATE_ENTRY = "goal-state";
const DEFAULT_MAX_TURNS = 8;
const GOAL_STATUS_KEY = "goal";
const EMPTY_PARAMETERS = {
	type: "object",
	properties: {},
	required: [],
	additionalProperties: false,
};

function now() {
	return Date.now();
}

function isStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "paused" || value === "complete" || value === "cleared";
}

function normalizePositiveInteger(value: unknown): number | undefined {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
	if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
	return Math.floor(numeric);
}

function normalizeState(value: unknown): GoalState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (!isStatus(raw.status)) return undefined;
	const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now();
	return {
		objective: typeof raw.objective === "string" && raw.objective.trim() ? raw.objective : undefined,
		status: raw.status,
		createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined,
		updatedAt,
		turnsUsed: normalizePositiveInteger(raw.turnsUsed) ?? 0,
		maxTurns: normalizePositiveInteger(raw.maxTurns) ?? DEFAULT_MAX_TURNS,
		lastReason: typeof raw.lastReason === "string" && raw.lastReason.trim() ? raw.lastReason : undefined,
	};
}

function getBranchEntries(ctx: ExtensionContext): any[] {
	const sessionManager = ctx.sessionManager as any;
	if (typeof sessionManager.getBranch === "function") return sessionManager.getBranch();
	if (typeof sessionManager.getEntries === "function") return sessionManager.getEntries();
	return [];
}

function isGoalPresent(state: GoalState | undefined): state is GoalState & { objective: string } {
	return !!state?.objective && state.status !== "cleared";
}

function isActiveGoal(state: GoalState | undefined): state is GoalState & { objective: string; status: "active" } {
	return isGoalPresent(state) && state.status === "active";
}

function statusLine(state: GoalState | undefined): string | undefined {
	if (!isActiveGoal(state)) return undefined;
	return `🎯 goal:${state.status} ${state.turnsUsed}/${state.maxTurns}`;
}

function formatGoalStatus(state: GoalState | undefined): string {
	if (!isGoalPresent(state)) return "No goal is set.\n\nUsage: /goal <objective>";
	const lines = [
		"Goal",
		`Status: ${state.status}`,
		`Objective: ${state.objective}`,
		`Turns: ${state.turnsUsed}/${state.maxTurns}`,
	];
	if (state.lastReason) lines.push(`Note: ${state.lastReason}`);
	lines.push("");
	lines.push(state.status === "active" ? "Commands: /goal pause, /goal complete, /goal clear" : "Commands: /goal resume, /goal complete, /goal clear");
	return lines.join("\n");
}

function kickoffPrompt(state: GoalState & { objective: string }): string {
	return `Goal set: ${state.objective}\n\nWork toward this goal. Continue until it is achieved, blocked, or you need user input. When the goal is fully achieved and no required work remains, call the goal_complete tool.`;
}

function continuationPrompt(state: GoalState & { objective: string }): string {
	const turnLabel = Math.max(1, state.turnsUsed);
	return `Continue pursuing the active goal: ${state.objective}\n\nProgress turn ${turnLabel} of ${state.maxTurns}. If the goal is fully achieved and no required work remains, call the goal_complete tool. If you are blocked or need user input, explain that instead of continuing indefinitely.`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

async function isIdle(ctx: ExtensionContext): Promise<boolean> {
	try {
		return typeof (ctx as any).isIdle !== "function" || (await (ctx as any).isIdle());
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let state: GoalState | undefined;
	let isContinuing = false;

	function setStatus(ctx: ExtensionContext) {
		if (ctx.hasUI) ctx.ui.setStatus(GOAL_STATUS_KEY, statusLine(state));
	}

	function persist(next: GoalState) {
		state = next;
		pi.appendEntry(STATE_ENTRY, { ...next });
	}

	function loadFromSession(ctx: ExtensionContext) {
		state = undefined;
		for (const entry of getBranchEntries(ctx)) {
			if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const next = normalizeState(entry.data);
			if (next) state = next;
		}
	}

	function sendGoalMessage(ctx: ExtensionContext, content: string, options?: { deliverAs?: "steer" | "followUp" }) {
		try {
			(pi as any).sendUserMessage(content, options);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isActiveGoal(state)) {
				persist({ ...state, status: "paused", updatedAt: now(), lastReason: `Could not send continuation: ${message}` });
				setStatus(ctx);
			}
			notify(ctx, `Goal paused: ${message}`, "error");
			return false;
		}
	}

	async function setGoal(ctx: ExtensionContext, objective: string) {
		const current = state;
		if (isGoalPresent(current) && (current.status === "active" || current.status === "paused")) {
			if (ctx.hasUI) {
				const replace = await ctx.ui.confirm("Replace current goal?", `Current goal: ${current.objective}\n\nNew goal: ${objective}`);
				if (!replace) {
					notify(ctx, "Goal unchanged", "info");
					return;
				}
			}
		}

		const timestamp = now();
		const next: GoalState = {
			objective,
			status: "active",
			createdAt: timestamp,
			updatedAt: timestamp,
			turnsUsed: 0,
			maxTurns: current?.maxTurns ?? DEFAULT_MAX_TURNS,
		};
		persist(next);
		setStatus(ctx);
		notify(ctx, `Goal set: ${objective}`, "info");
		sendGoalMessage(ctx, kickoffPrompt(next as GoalState & { objective: string }));
	}

	function updateGoalStatus(ctx: ExtensionContext, status: GoalStatus, reason?: string) {
		if (!isGoalPresent(state)) {
			notify(ctx, "No goal is set", "warning");
			return;
		}
		const next: GoalState = { ...state, status, updatedAt: now(), lastReason: reason };
		persist(next);
		setStatus(ctx);
		notify(ctx, status === "cleared" ? "Goal cleared" : `Goal ${status}`, "info");
	}

	function showStatus(ctx: ExtensionContext) {
		notify(ctx, formatGoalStatus(state), "info");
		setStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		loadFromSession(ctx);
		setStatus(ctx);
	});

	pi.registerCommand("goal", {
		description: "Set and pursue a persistent session goal: /goal [status|pause|resume|complete|clear|<objective>]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const command = trimmed.toLowerCase();
			if (!trimmed || command === "status") {
				showStatus(ctx);
				return;
			}
			if (command === "pause") {
				updateGoalStatus(ctx, "paused", "Paused by user");
				return;
			}
			if (command === "resume") {
				updateGoalStatus(ctx, "active", "Resumed by user");
				if (isActiveGoal(state) && await isIdle(ctx)) sendGoalMessage(ctx, continuationPrompt(state));
				return;
			}
			if (command === "complete") {
				updateGoalStatus(ctx, "complete", "Completed by user");
				return;
			}
			if (command === "clear") {
				updateGoalStatus(ctx, "cleared", "Cleared by user");
				return;
			}
			await setGoal(ctx, trimmed);
		},
	});

	pi.registerTool({
		name: "goal_status",
		label: "Goal Status",
		description: "Return the current persistent session goal, if one is set.",
		promptSnippet: "Inspect the active /goal objective and continuation status",
		parameters: EMPTY_PARAMETERS,
		async execute() {
			return {
				content: [{ type: "text", text: formatGoalStatus(state) }],
				details: { goal: isGoalPresent(state) ? { ...state } : null },
			};
		},
	});

	pi.registerTool({
		name: "goal_complete",
		label: "Complete Goal",
		description: "Mark the active /goal objective complete only when it has actually been achieved and no required work remains.",
		promptSnippet: "Mark the active /goal objective complete after achieving it",
		promptGuidelines: [
			"Use goal_complete only when the active /goal objective has actually been achieved and no required work remains.",
			"Do not use goal_complete merely because the continuation cap is near or because you are stopping work.",
		],
		parameters: EMPTY_PARAMETERS,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!isGoalPresent(state)) {
				return { content: [{ type: "text", text: "No goal is set." }], details: { goal: null } };
			}
			if (!isActiveGoal(state)) {
				return { content: [{ type: "text", text: `No active goal to complete; current goal is ${state.status}.` }], details: { goal: { ...state } } };
			}
			const next: GoalState = { ...state, status: "complete", updatedAt: now(), lastReason: "Completed by agent" };
			persist(next);
			setStatus(ctx);
			return {
				content: [{ type: "text", text: `Goal complete: ${next.objective}` }],
				details: { goal: { ...next } },
			};
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!isActiveGoal(state)) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\nActive persistent goal:\n- Objective: ${state.objective}\n- Continuation turn budget: ${state.turnsUsed}/${state.maxTurns}\nPursue this goal until it is achieved, blocked, or user input is required. When the goal is fully achieved and no required work remains, call goal_complete. Do not call goal_complete merely because the continuation cap is near or because you are stopping work.`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!isActiveGoal(state) || isContinuing) return undefined;
		if (state.turnsUsed >= state.maxTurns) {
			persist({ ...state, status: "paused", updatedAt: now(), lastReason: "Paused after reaching the continuation cap" });
			setStatus(ctx);
			notify(ctx, "Goal paused after reaching the continuation cap", "warning");
			return undefined;
		}
		try {
			if (typeof (ctx as any).hasPendingMessages !== "function") return undefined;
			if (await (ctx as any).hasPendingMessages()) return undefined;
		} catch {
			return undefined;
		}
		isContinuing = true;
		const next = { ...state, turnsUsed: state.turnsUsed + 1, updatedAt: now() };
		persist(next);
		setStatus(ctx);
		try {
			sendGoalMessage(ctx, continuationPrompt(next), { deliverAs: "followUp" });
		} finally {
			isContinuing = false;
		}
		return undefined;
	});
}
