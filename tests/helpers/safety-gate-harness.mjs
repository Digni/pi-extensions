import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function withFakeReviewer(verdict, run) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safety-reviewer-"));
	const scriptPath = path.join(dir, "fake-pi.mjs");
	const invocationPath = path.join(dir, "invocation.json");
	const tracePath = path.join(dir, "models.log");
	fs.writeFileSync(
		scriptPath,
		`import fs from "node:fs";\nconst args = process.argv.slice(2);\nconst model = args[args.indexOf("--model") + 1];\nconst verdicts = process.env.SAFETY_TEST_VERDICTS ? JSON.parse(process.env.SAFETY_TEST_VERDICTS) : {};\nconst verdict = verdicts[model] ?? process.env.SAFETY_TEST_VERDICT;\nconst message = typeof verdict === "object" ? { role: "assistant", content: [], stopReason: "error", errorMessage: verdict.error } : { role: "assistant", content: [{ type: "text", text: verdict }] };\nfs.writeFileSync(process.env.SAFETY_TEST_INVOCATION, JSON.stringify({ args, cwd: process.cwd() }));\nfs.appendFileSync(process.env.SAFETY_TEST_TRACE, model + "\\n");\nconsole.log(JSON.stringify({ type: "message_end", message }));\n`,
	);
	const previousScript = process.argv[1];
	const previousInvocation = process.env.SAFETY_TEST_INVOCATION;
	const previousTrace = process.env.SAFETY_TEST_TRACE;
	const previousVerdict = process.env.SAFETY_TEST_VERDICT;
	const previousVerdicts = process.env.SAFETY_TEST_VERDICTS;
	process.argv[1] = scriptPath;
	process.env.SAFETY_TEST_INVOCATION = invocationPath;
	process.env.SAFETY_TEST_TRACE = tracePath;
	if (typeof verdict === "string") {
		process.env.SAFETY_TEST_VERDICT = verdict;
		delete process.env.SAFETY_TEST_VERDICTS;
	} else {
		delete process.env.SAFETY_TEST_VERDICT;
		process.env.SAFETY_TEST_VERDICTS = JSON.stringify(verdict);
	}
	try {
		return await run({ invocationPath, tracePath });
	} finally {
		process.argv[1] = previousScript;
		if (previousInvocation === undefined) delete process.env.SAFETY_TEST_INVOCATION;
		else process.env.SAFETY_TEST_INVOCATION = previousInvocation;
		if (previousTrace === undefined) delete process.env.SAFETY_TEST_TRACE;
		else process.env.SAFETY_TEST_TRACE = previousTrace;
		if (previousVerdict === undefined) delete process.env.SAFETY_TEST_VERDICT;
		else process.env.SAFETY_TEST_VERDICT = previousVerdict;
		if (previousVerdicts === undefined) delete process.env.SAFETY_TEST_VERDICTS;
		else process.env.SAFETY_TEST_VERDICTS = previousVerdicts;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export function makeModel(provider, id, options = {}) {
	return {
		provider,
		id,
		name: options.name ?? id,
		cost: options.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 128_000,
		maxTokens: options.maxTokens ?? 16_000,
	};
}

export async function loadSafetyGate(models, {
	hasUI = true,
	mode = "auto",
	config = {},
	registeredProviderIds = [],
	exposeRegisteredProviderIds = true,
	confirmResult = false,
	inputResult = "",
	sessionEntries = [],
	sessionBranch = sessionEntries,
} = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "safety-home-"));
	process.env.HOME = home;
	const configDir = path.join(home, ".pi", "agent", "extensions", "safety-gate");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ mode, ...config }));

	const moduleUrl = new URL(`../../extensions/safety-gate/index.ts?test=${Date.now()}-${Math.random()}`, import.meta.url);
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
	const selections = [];
	const confirmations = [];
	const inputs = [];
	const ctx = {
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), "safety-cwd-")),
		hasUI,
		ui: {
			setStatus() {},
			notify(message, level) { notifications.push({ message, level }); },
			async select(title, options) {
				selections.push({ title, options });
				return options[0];
			},
			async confirm(title, message) {
				confirmations.push({ title, message });
				return confirmResult;
			},
			async input(title, placeholder) {
				inputs.push({ title, placeholder });
				return inputResult;
			},
		},
		sessionManager: {
			getEntries() { return sessionEntries; },
			getBranch() { return sessionBranch; },
		},
		modelRegistry: {
			getAvailable() { return models; },
			...(exposeRegisteredProviderIds ? { getRegisteredProviderIds() { return registeredProviderIds; } } : {}),
		},
		signal: undefined,
	};

	await hooks.get("session_start")({}, ctx);
	return { hooks, commands, flags, appended, notifications, selections, confirmations, inputs, ctx, home };
}
