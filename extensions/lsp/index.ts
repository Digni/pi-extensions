import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

type TurnEndSummaryMode = "off" | "errors-only" | "all";
type SeverityFilter = "error" | "warning" | "info" | "hint" | "all";

type ServerConfig = {
	enabled?: boolean;
	command: string;
	args?: string[];
	extensions: string[];
	languageId?: string;
	rootMarkers?: string[];
	preferFlutterSdk?: boolean;
	solutionRequired?: boolean;
	solutionExtensions?: string[];
};

type LspConfig = {
	servers: Record<string, ServerConfig>;
	diagnostics: {
		turnEndSummary: TurnEndSummaryMode;
		debounceMs: number;
	};
};

type Workspace = {
	key: string;
	serverName: string;
	rootPath: string;
	rootUri: string;
	args: string[];
	solutionPath?: string;
};

type DocumentState = {
	uri: string;
	filePath: string;
	serverKey: string;
	languageId: string;
	version: number;
	text: string;
};

type NormalizedDiagnostic = {
	severity: SeverityFilter;
	message: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
	source?: string;
	code?: string;
};

type DiagnosticEntry = {
	uri: string;
	filePath: string;
	serverKey: string;
	versionAtReceive: number;
	lspVersion?: number;
	receivedAt: number;
	diagnostics: NormalizedDiagnostic[];
};

type WorkspaceResolution =
	| { ok: true; workspace: Workspace }
	| { ok: false; reason: string; candidates?: string[] };

const CONFIG_PATH = path.join(process.env.HOME ?? ".", ".pi", "agent", "extensions", "lsp", "config.json");
const DEFAULT_CONFIG: LspConfig = {
	servers: {
		csharp: {
			command: "csharp-ls",
			args: [],
			extensions: [".cs"],
			languageId: "csharp",
			solutionRequired: true,
			solutionExtensions: [".sln", ".slnx"],
			rootMarkers: [".sln", ".slnx", ".git"],
		},
		dart: {
			command: "dart",
			args: ["language-server", "--protocol=lsp"],
			extensions: [".dart"],
			languageId: "dart",
			rootMarkers: ["pubspec.yaml", "analysis_options.yaml", ".git"],
			preferFlutterSdk: true,
		},
		go: {
			command: "gopls",
			args: ["serve"],
			extensions: [".go"],
			languageId: "go",
			rootMarkers: ["go.work", "go.mod", ".git"],
		},
		rust: {
			command: "rust-analyzer",
			args: [],
			extensions: [".rs"],
			languageId: "rust",
			rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
		},
		typescript: {
			enabled: false,
			command: "typescript-language-server",
			args: ["--stdio"],
			extensions: [".ts", ".tsx", ".js", ".jsx"],
			languageId: "typescript",
			rootMarkers: ["package.json", "tsconfig.json", ".git"],
		},
	},
	diagnostics: {
		turnEndSummary: "errors-only",
		debounceMs: 750,
	},
};

const diagnosticsToolSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Optional file path to sync before returning diagnostics" })),
	severity: Type.Optional(Type.String({ description: "error, warning, info, hint, or all (default all)" })),
});

function cloneDefaultConfig(): LspConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function normalizeConfig(value: unknown): LspConfig {
	const fallback = cloneDefaultConfig();
	const raw = value && typeof value === "object" ? (value as any) : {};
	const servers: Record<string, ServerConfig> = {};
	const rawServers = raw.servers && typeof raw.servers === "object" ? (raw.servers as Record<string, any>) : {};
	const mergedServers: Record<string, any> = { ...fallback.servers };
	for (const [name, rawServer] of Object.entries(rawServers)) {
		const defaultServer = fallback.servers[name];
		mergedServers[name] = defaultServer && rawServer && typeof rawServer === "object" ? { ...defaultServer, ...rawServer } : rawServer;
	}
	for (const [name, server] of Object.entries(mergedServers)) {
		if (!server || typeof server !== "object") continue;
		if (typeof server.command !== "string" || !server.command.trim()) continue;
		if (!Array.isArray(server.extensions)) continue;
		servers[name] = {
			enabled: typeof server.enabled === "boolean" ? server.enabled : true,
			command: server.command,
			args: Array.isArray(server.args) ? server.args.filter((arg: unknown) => typeof arg === "string") : [],
			extensions: server.extensions.filter((ext: unknown) => typeof ext === "string").map((ext: string) => ext.toLowerCase()),
			languageId: typeof server.languageId === "string" ? server.languageId : undefined,
			rootMarkers: Array.isArray(server.rootMarkers) ? server.rootMarkers.filter((marker: unknown) => typeof marker === "string") : [],
			preferFlutterSdk: !!server.preferFlutterSdk,
			solutionRequired: !!server.solutionRequired,
			solutionExtensions: Array.isArray(server.solutionExtensions)
				? server.solutionExtensions.filter((ext: unknown) => typeof ext === "string").map((ext: string) => ext.toLowerCase())
				: [".sln", ".slnx"],
		};
	}
	if (Object.keys(servers).length === 0) servers.csharp = fallback.servers.csharp;
	const turnEndSummary = ["off", "errors-only", "all"].includes(raw.diagnostics?.turnEndSummary)
		? (raw.diagnostics.turnEndSummary as TurnEndSummaryMode)
		: fallback.diagnostics.turnEndSummary;
	const debounceMs = Number.isFinite(raw.diagnostics?.debounceMs) && raw.diagnostics.debounceMs >= 0 ? Math.floor(raw.diagnostics.debounceMs) : fallback.diagnostics.debounceMs;
	return { servers, diagnostics: { turnEndSummary, debounceMs } };
}

function loadConfig(): LspConfig {
	try {
		return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
	} catch (error: any) {
		if (error?.code !== "ENOENT") console.warn(`[lsp] Failed to read ${CONFIG_PATH}: ${error?.message ?? error}`);
		return cloneDefaultConfig();
	}
}

function pathToFileUri(filePath: string): string {
	const resolved = path.resolve(filePath);
	const withForwardSlashes = resolved.split(path.sep).map(encodeURIComponent).join("/");
	return `file://${withForwardSlashes.startsWith("/") ? "" : "/"}${withForwardSlashes}`;
}

function fileUriToPath(uri: string): string {
	try {
		return decodeURIComponent(new URL(uri).pathname);
	} catch {
		return uri;
	}
}

function canonicalPath(filePath: string): string {
	try {
		return fs.realpathSync.native(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function resolveInputPath(cwd: string, inputPath: string): string {
	const expanded = inputPath === "~" || inputPath.startsWith("~/") ? path.join(process.env.HOME ?? "~", inputPath.slice(2)) : inputPath;
	return path.resolve(cwd, expanded.replace(/^@/, ""));
}

function getToolPath(input: any): string | undefined {
	const raw = input?.path ?? input?.file_path ?? input?.filePath;
	return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function findServerForFile(config: LspConfig, filePath: string): { name: string; server: ServerConfig } | undefined {
	const ext = path.extname(filePath).toLowerCase();
	for (const [name, server] of Object.entries(config.servers)) {
		if (server.enabled === false) continue;
		if (server.extensions.map((e) => e.toLowerCase()).includes(ext)) return { name, server };
	}
	return undefined;
}

function listSolutions(dir: string, solutionExtensions: string[]): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && solutionExtensions.includes(path.extname(entry.name).toLowerCase()))
			.map((entry) => path.join(dir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

function findSolution(startFile: string, solutionExtensions: string[]): { solutionPath: string; rootPath: string } | { error: string; candidates?: string[] } {
	let dir = path.dirname(path.resolve(startFile));
	while (true) {
		const solutions = listSolutions(dir, solutionExtensions);
		if (solutions.length === 1) return { solutionPath: solutions[0], rootPath: dir };
		if (solutions.length > 1) {
			const dirName = path.basename(dir).toLowerCase();
			const matching = solutions.filter((solution) => path.basename(solution, path.extname(solution)).toLowerCase() === dirName);
			if (matching.length === 1) return { solutionPath: matching[0], rootPath: dir };
			return { error: `ambiguous solution in ${dir}`, candidates: solutions };
		}
		const parent = path.dirname(dir);
		if (parent === dir) return { error: `missing solution (${solutionExtensions.join("/")}) for ${startFile}` };
		dir = parent;
	}
}

function findRootByMarkers(startFile: string, rootMarkers: string[] | undefined, fallbackRoot: string): string {
	const dirs: string[] = [];
	let dir = path.dirname(path.resolve(startFile));
	while (true) {
		dirs.push(dir);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const marker of rootMarkers ?? []) {
		if (!marker || marker.startsWith("*")) continue;
		for (const candidate of dirs) {
			if (fs.existsSync(path.join(candidate, marker))) return candidate;
		}
	}
	return path.resolve(fallbackRoot);
}

function findExecutableOnPath(command: string): string | undefined {
	if (command.includes(path.sep)) return fs.existsSync(command) ? command : undefined;
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, command);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// keep searching
		}
	}
	return undefined;
}

function isFlutterWorkspace(rootPath: string): boolean {
	try {
		const pubspec = fs.readFileSync(path.join(rootPath, "pubspec.yaml"), "utf8");
		return /^\s*flutter\s*:/m.test(pubspec) || /sdk\s*:\s*flutter\b/.test(pubspec);
	} catch {
		return false;
	}
}

function findFlutterBundledDart(): string | undefined {
	const flutter = findExecutableOnPath("flutter");
	if (!flutter) return undefined;
	try {
		const realFlutter = fs.realpathSync.native(flutter);
		const flutterSdk = path.dirname(path.dirname(realFlutter));
		const bundledDart = path.join(flutterSdk, "bin", "cache", "dart-sdk", "bin", "dart");
		return fs.existsSync(bundledDart) ? bundledDart : undefined;
	} catch {
		return undefined;
	}
}

function resolveCommand(command: string, server?: ServerConfig, workspace?: Workspace): string {
	if (command === "csharp-ls") {
		const dotnetTool = path.join(process.env.HOME ?? "", ".dotnet", "tools", "csharp-ls");
		if (dotnetTool && fs.existsSync(dotnetTool)) return dotnetTool;
	}
	if (command === "dart" && server?.preferFlutterSdk && workspace && isFlutterWorkspace(workspace.rootPath)) {
		return findFlutterBundledDart() ?? command;
	}
	return command;
}

function resolveWorkspace(ctx: ExtensionContext, serverName: string, server: ServerConfig, filePath: string): WorkspaceResolution {
	const baseArgs = [...(server.args ?? [])];
	if (server.solutionRequired) {
		const solution = findSolution(filePath, server.solutionExtensions ?? [".sln", ".slnx"]);
		if ("error" in solution) return { ok: false, reason: solution.error, candidates: solution.candidates };
		const solutionArg = path.relative(solution.rootPath, solution.solutionPath) || path.basename(solution.solutionPath);
		const args = baseArgs.includes("--solution") || baseArgs.includes("-s") ? baseArgs : [...baseArgs, "--solution", solutionArg];
		return {
			ok: true,
			workspace: {
				key: `${serverName}:${solution.rootPath}`,
				serverName,
				rootPath: solution.rootPath,
				rootUri: pathToFileUri(solution.rootPath),
				args,
				solutionPath: solution.solutionPath,
			},
		};
	}
	const rootPath = findRootByMarkers(filePath, server.rootMarkers, ctx.cwd);
	return {
		ok: true,
		workspace: {
			key: `${serverName}:${rootPath}`,
			serverName,
			rootPath,
			rootUri: pathToFileUri(rootPath),
			args: baseArgs,
		},
	};
}

function normalizeSeverity(value: unknown): SeverityFilter {
	if (value === 1) return "error";
	if (value === 2) return "warning";
	if (value === 3) return "info";
	if (value === 4) return "hint";
	return "info";
}

function normalizeDiagnostic(raw: any): NormalizedDiagnostic | undefined {
	const message = typeof raw?.message === "string" ? raw.message : undefined;
	const start = raw?.range?.start;
	if (!message || typeof start?.line !== "number" || typeof start?.character !== "number") return undefined;
	const end = raw?.range?.end;
	return {
		severity: normalizeSeverity(raw.severity),
		message,
		line: start.line + 1,
		character: start.character + 1,
		endLine: typeof end?.line === "number" ? end.line + 1 : undefined,
		endCharacter: typeof end?.character === "number" ? end.character + 1 : undefined,
		source: typeof raw.source === "string" ? raw.source : undefined,
		code: raw.code === undefined ? undefined : String(raw.code),
	};
}

function truncate(value: string, max = 48_000): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n… (${value.length - max} more chars truncated)`;
}

function diagnosticCounts(entries: Iterable<DiagnosticEntry>) {
	let error = 0;
	let warning = 0;
	let info = 0;
	let hint = 0;
	for (const entry of entries) {
		for (const diagnostic of entry.diagnostics) {
			if (diagnostic.severity === "error") error++;
			else if (diagnostic.severity === "warning") warning++;
			else if (diagnostic.severity === "info") info++;
			else if (diagnostic.severity === "hint") hint++;
		}
	}
	return { error, warning, info, hint, total: error + warning + info + hint };
}

function formatDiagnostics(entries: DiagnosticEntry[], filter: SeverityFilter = "all"): string {
	const lines: string[] = [];
	for (const entry of entries.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
		const diagnostics = entry.diagnostics.filter((diagnostic) => filter === "all" || diagnostic.severity === filter);
		if (diagnostics.length === 0) continue;
		lines.push(`${entry.filePath} (${diagnostics.length})`);
		for (const diagnostic of diagnostics) {
			const code = diagnostic.code ? ` ${diagnostic.code}` : "";
			const source = diagnostic.source ? ` [${diagnostic.source}${code}]` : code;
			lines.push(`  ${diagnostic.line}:${diagnostic.character} ${diagnostic.severity.toUpperCase()}${source} ${diagnostic.message.replace(/\s+/g, " ").trim()}`);
		}
	}
	return lines.length === 0 ? "No matching LSP diagnostics." : truncate(lines.join("\n"));
}

class LspServer {
	private proc?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private startPromise?: Promise<void>;
	private stopping = false;
	status: "idle" | "starting" | "running" | "failed" | "stopped" | "exited" = "idle";
	lastError?: string;
	stderrTail = "";
	startedAt?: number;

	constructor(
		private readonly name: string,
		private readonly config: ServerConfig,
		readonly workspace: Workspace,
		private readonly onDiagnostics: (serverKey: string, params: any) => void,
		private readonly onStateChange: () => void,
	) {}

	commandLine() {
		return `${resolveCommand(this.config.command, this.config, this.workspace)} ${this.workspace.args.join(" ")}`.trimEnd();
	}

	async start() {
		if (this.status === "running") return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.startInner();
		return this.startPromise;
	}

	private async startInner() {
		this.status = "starting";
		this.lastError = undefined;
		this.onStateChange();
		const command = resolveCommand(this.config.command, this.config, this.workspace);
		this.proc = spawn(command, this.workspace.args, {
			cwd: this.workspace.rootPath,
			shell: false,
			stdio: "pipe",
		});
		this.startedAt = Date.now();
		this.proc.stdout.on("data", (data) => this.onStdout(Buffer.from(data)));
		this.proc.stderr.on("data", (data) => {
			this.stderrTail = truncate(`${this.stderrTail}${data.toString()}`, 8000);
		});
		this.proc.on("error", (error) => {
			this.status = "failed";
			this.lastError = error.message;
			this.rejectAll(error);
			this.onStateChange();
		});
		this.proc.on("close", (code, signal) => {
			if (this.stopping) this.status = "stopped";
			else this.status = code === 0 ? "exited" : "failed";
			if (!this.lastError && code !== 0) this.lastError = `exited with code ${code}${signal ? ` signal ${signal}` : ""}`;
			this.rejectAll(new Error(this.lastError ?? "language server exited"));
			this.onStateChange();
		});
		const init = await this.request(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "pi-lsp-extension" },
				rootPath: this.workspace.rootPath,
				rootUri: this.workspace.rootUri,
				workspaceFolders: [{ uri: this.workspace.rootUri, name: path.basename(this.workspace.rootPath) || this.workspace.rootPath }],
				capabilities: {
					workspace: { workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: true },
						publishDiagnostics: {
							relatedInformation: true,
							versionSupport: true,
							codeDescriptionSupport: true,
							dataSupport: true,
							tagSupport: { valueSet: [1, 2] },
						},
					},
				},
				trace: "off",
			},
			20_000,
		);
		if (!init) throw new Error(`${this.name} initialize returned no result`);
		this.notify("initialized", {});
		if (this.config.solutionRequired || this.config.command === "csharp-ls") {
			// csharp-ls returns initialize before the solution is fully loaded. Delay the
			// first didOpen so .sln/.slnx-backed workspaces are ready to accept files.
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
		this.status = "running";
		this.onStateChange();
	}

	async stop() {
		this.stopping = true;
		if (!this.proc || this.proc.killed) {
			this.status = "stopped";
			return;
		}
		try {
			if (this.status === "running") await this.request("shutdown", null, 3000).catch(() => undefined);
			this.notify("exit", undefined);
		} finally {
			setTimeout(() => {
				if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
			}, 500);
		}
	}

	didOpen(document: DocumentState) {
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri: document.uri,
				languageId: document.languageId,
				version: document.version,
				text: document.text,
			},
		});
	}

	didChange(document: DocumentState) {
		this.notify("textDocument/didChange", {
			textDocument: { uri: document.uri, version: document.version },
			contentChanges: [{ text: document.text }],
		});
	}

	didSave(document: DocumentState) {
		this.notify("textDocument/didSave", {
			textDocument: { uri: document.uri },
			text: document.text,
		});
	}

	async pullDiagnostics(document: DocumentState) {
		try {
			const result = await this.request("textDocument/diagnostic", { textDocument: { uri: document.uri } }, 5000);
			if (result?.kind === "full" && Array.isArray(result.items)) {
				this.onDiagnostics(this.workspace.key, { uri: document.uri, version: document.version, diagnostics: result.items });
			}
		} catch (error: any) {
			// Many servers still use publishDiagnostics only. Keep pull failures visible
			// in /lsp status without failing the edit/write/tool call.
			this.lastError = `diagnostic pull failed: ${error?.message ?? error}`;
		}
	}

	private request(method: string, params: any, timeoutMs = 15_000): Promise<any> {
		const id = this.nextId++;
		const payload = { jsonrpc: "2.0", id, method, params };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.writeMessage(payload);
		});
	}

	private notify(method: string, params: any) {
		this.writeMessage({ jsonrpc: "2.0", method, params });
	}

	private writeMessage(payload: any) {
		const body = JSON.stringify(payload);
		const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
		if (!this.proc || !this.proc.stdin.writable) throw new Error(`${this.name} is not running`);
		this.proc.stdin.write(header + body, "utf8");
	}

	private onStdout(data: Buffer) {
		this.buffer = Buffer.concat([this.buffer, data]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const header = this.buffer.slice(0, headerEnd).toString("ascii");
			const match = header.match(/Content-Length:\s*(\d+)/i);
			if (!match) {
				this.buffer = Buffer.alloc(0);
				this.lastError = "Invalid LSP frame without Content-Length";
				return;
			}
			const length = Number.parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (this.buffer.length < bodyEnd) return;
			const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
			this.buffer = this.buffer.slice(bodyEnd);
			try {
				this.handleMessage(JSON.parse(body));
			} catch (error: any) {
				this.lastError = `Failed to parse LSP message: ${error?.message ?? error}`;
			}
		}
	}

	private handleMessage(message: any) {
		if (typeof message.id === "number" && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id)!;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
			else pending.resolve(message.result);
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			this.onDiagnostics(this.workspace.key, message.params);
		}
	}

	private rejectAll(error: Error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	const servers = new Map<string, LspServer>();
	const documents = new Map<string, DocumentState>();
	const diagnostics = new Map<string, DiagnosticEntry>();
	const warnings = new Map<string, { message: string; candidates?: string[]; timestamp: number }>();
	let statusCtx: ExtensionContext | undefined;
	let statusTimer: NodeJS.Timeout | undefined;
	let active = false;
	let diagnosticsChangedThisTurn = false;
	let lastTurnSummaryKey = "";

	function setStatus(ctx = statusCtx) {
		if (!active || !ctx) return;
		try {
			const failed = [...servers.values()].filter((server) => server.status === "failed").length;
			if (failed > 0 || warnings.size > 0) {
				ctx.ui.setStatus("lsp", failed > 0 ? `🧠 lsp:error` : `🧠 lsp:warn`);
				return;
			}
			if (documents.size === 0) {
				ctx.ui.setStatus("lsp", "🧠 lsp:idle");
				return;
			}
			const counts = diagnosticCounts(diagnostics.values());
			if (counts.error || counts.warning) ctx.ui.setStatus("lsp", `🧠 lsp:${counts.error}E ${counts.warning}W`);
			else ctx.ui.setStatus("lsp", "🧠 lsp:ok");
		} catch {
			// Contexts become stale during print-mode shutdown/reload. Status is best-effort.
		}
	}

	function scheduleStatus(ctx = statusCtx) {
		if (!active) return;
		if (ctx) statusCtx = ctx;
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => setStatus(), config.diagnostics.debounceMs);
	}

	function addWarning(key: string, message: string, candidates?: string[]) {
		warnings.set(key, { message, candidates, timestamp: Date.now() });
		scheduleStatus();
	}

	function clearWarning(key: string) {
		if (warnings.delete(key)) scheduleStatus();
	}

	function onDiagnostics(serverKey: string, params: any) {
		const uri = typeof params?.uri === "string" ? params.uri : undefined;
		if (!uri) return;
		const document = documents.get(uri);
		const lspVersion = typeof params.version === "number" ? params.version : undefined;
		if (document && lspVersion !== undefined && lspVersion < document.version) return;
		const normalized = Array.isArray(params.diagnostics) ? params.diagnostics.map(normalizeDiagnostic).filter(Boolean) as NormalizedDiagnostic[] : [];
		diagnostics.set(uri, {
			uri,
			filePath: document?.filePath ?? fileUriToPath(uri),
			serverKey,
			versionAtReceive: document?.version ?? 0,
			lspVersion,
			receivedAt: Date.now(),
			diagnostics: normalized,
		});
		diagnosticsChangedThisTurn = true;
		scheduleStatus();
	}

	async function getOrStartServer(ctx: ExtensionContext, serverName: string, serverConfig: ServerConfig, workspace: Workspace) {
		let server = servers.get(workspace.key);
		if (!server) {
			server = new LspServer(serverName, serverConfig, workspace, onDiagnostics, () => scheduleStatus(ctx));
			servers.set(workspace.key, server);
		}
		await server.start();
		return server;
	}

	async function syncFile(ctx: ExtensionContext, rawPath: string): Promise<string> {
		statusCtx = ctx;
		const filePath = canonicalPath(resolveInputPath(ctx.cwd, rawPath));
		const match = findServerForFile(config, filePath);
		if (!match) return `No enabled LSP server configured for ${filePath}`;
		if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return `File does not exist: ${filePath}`;
		const workspaceResolution = resolveWorkspace(ctx, match.name, match.server, filePath);
		const warningKey = `${match.name}:${filePath}`;
		if (!workspaceResolution.ok) {
			addWarning(warningKey, workspaceResolution.reason, workspaceResolution.candidates);
			return workspaceResolution.reason;
		}
		clearWarning(warningKey);
		const text = fs.readFileSync(filePath, "utf8");
		const uri = pathToFileUri(filePath);
		const languageId = match.server.languageId ?? match.name;
		const existing = documents.get(uri);
		const document: DocumentState = {
			uri,
			filePath,
			serverKey: workspaceResolution.workspace.key,
			languageId,
			version: existing ? existing.version + 1 : 1,
			text,
		};
		const server = await getOrStartServer(ctx, match.name, match.server, workspaceResolution.workspace);
		documents.set(uri, document);
		if (!existing || existing.serverKey !== document.serverKey) server.didOpen(document);
		else server.didChange(document);
		server.didSave(document);
		void server.pullDiagnostics(document).then(() => scheduleStatus(ctx));
		scheduleStatus(ctx);
		return `Synced ${filePath} with ${match.name}`;
	}

	function getDiagnosticEntries(pathFilter?: string, cwd?: string): DiagnosticEntry[] {
		if (!pathFilter) return [...diagnostics.values()];
		const resolved = canonicalPath(cwd ? resolveInputPath(cwd, pathFilter) : path.resolve(pathFilter));
		return [...diagnostics.values()].filter((entry) => canonicalPath(entry.filePath) === resolved);
	}

	function parseDotnetBuildDiagnostics(output: string, serverKey: string): DiagnosticEntry[] {
		const byUri = new Map<string, DiagnosticEntry>();
		const seen = new Set<string>();
		const pattern = /^(.*)\((\d+),(\d+)(?:,\d+,\d+)?\):\s+(error|warning)\s+([^:]+):\s+(.*?)\s+\[[^\]]+\]$/gm;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(output))) {
			const filePath = canonicalPath(match[1].trim());
			const uri = pathToFileUri(filePath);
			const severity = match[4] === "error" ? "error" : "warning";
			const line = Number.parseInt(match[2], 10);
			const character = Number.parseInt(match[3], 10);
			const code = match[5].trim();
			const message = match[6].trim();
			const key = `${uri}:${line}:${character}:${severity}:${code}:${message}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const diagnostic: NormalizedDiagnostic = {
				severity,
				message,
				line,
				character,
				source: "dotnet build",
				code,
			};
			const existing = byUri.get(uri) ?? {
				uri,
				filePath,
				serverKey,
				versionAtReceive: documents.get(uri)?.version ?? 0,
				receivedAt: Date.now(),
				diagnostics: [],
			};
			existing.diagnostics.push(diagnostic);
			byUri.set(uri, existing);
		}
		return [...byUri.values()];
	}

	async function runCsharpBuildFallback(ctx: ExtensionContext, pathFilter?: string): Promise<string | undefined> {
		const target = pathFilter ? canonicalPath(resolveInputPath(ctx.cwd, pathFilter)) : undefined;
		const document = target
			? documents.get(pathToFileUri(target))
			: [...documents.values()].find((doc) => doc.languageId === "csharp");
		if (!document || document.languageId !== "csharp") return undefined;
		const server = servers.get(document.serverKey);
		const solutionPath = server?.workspace.solutionPath;
		if (!solutionPath) return undefined;
		const result = await pi.exec("dotnet", ["build", solutionPath, "--nologo"], { timeout: 120_000, signal: ctx.signal });
		const output = `${(result as any).stdout ?? ""}\n${(result as any).stderr ?? ""}`;
		const buildEntries = parseDotnetBuildDiagnostics(output, document.serverKey);
		for (const entry of buildEntries) diagnostics.set(entry.uri, entry);
		if (target && !buildEntries.some((entry) => canonicalPath(entry.filePath) === target)) {
			diagnostics.set(pathToFileUri(target), {
				uri: pathToFileUri(target),
				filePath: target,
				serverKey: document.serverKey,
				versionAtReceive: document.version,
				receivedAt: Date.now(),
				diagnostics: [],
			});
		}
		return `No LSP diagnostics were available; ran dotnet build fallback for ${solutionPath}.`;
	}

	function formatStatus() {
		const lines: string[] = [];
		lines.push(`Config: ${CONFIG_PATH}`);
		lines.push(`Servers configured: ${Object.entries(config.servers).map(([name, server]) => `${name}${server.enabled === false ? "(disabled)" : ""}`).join(", ") || "none"}`);
		lines.push(`Running server instances: ${servers.size}`);
		for (const [key, server] of servers) {
			lines.push(`- ${key}: ${server.status} root=${server.workspace.rootPath}`);
			if (server.workspace.solutionPath) lines.push(`  solution=${server.workspace.solutionPath}`);
			lines.push(`  command=${server.commandLine()}`);
			if (server.lastError) lines.push(`  error=${server.lastError}`);
			if (server.stderrTail.trim()) lines.push(`  stderr=${truncate(server.stderrTail.trim(), 1200)}`);
		}
		lines.push(`Tracked documents: ${documents.size}`);
		for (const document of documents.values()) lines.push(`- v${document.version} ${document.languageId} ${document.filePath}`);
		const counts = diagnosticCounts(diagnostics.values());
		lines.push(`Diagnostics: ${counts.error} error, ${counts.warning} warning, ${counts.info} info, ${counts.hint} hint`);
		if (warnings.size > 0) {
			lines.push("Warnings:");
			for (const warning of warnings.values()) {
				lines.push(`- ${warning.message}`);
				for (const candidate of warning.candidates ?? []) lines.push(`  candidate: ${candidate}`);
			}
		}
		return truncate(lines.join("\n"));
	}

	async function stopAll(updateStatus = true) {
		const current = [...servers.values()];
		servers.clear();
		await Promise.all(current.map((server) => server.stop().catch(() => undefined)));
		if (updateStatus) setStatus();
	}

	pi.on("session_start", async (_event, ctx) => {
		active = true;
		statusCtx = ctx;
		config = loadConfig();
		setStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		active = false;
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = undefined;
		await stopAll(false);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return undefined;
		const filePath = getToolPath((event as any).input);
		if (!filePath) return undefined;
		void syncFile(ctx, filePath).catch((error) => addWarning(`sync:${filePath}`, `LSP sync failed for ${filePath}: ${error?.message ?? error}`));
		return undefined;
	});

	pi.on("turn_start", async () => {
		diagnosticsChangedThisTurn = false;
	});

	pi.on("turn_end", async () => {
		if (!diagnosticsChangedThisTurn || config.diagnostics.turnEndSummary === "off") return undefined;
		const filter: SeverityFilter = config.diagnostics.turnEndSummary === "errors-only" ? "error" : "all";
		const entries = getDiagnosticEntries();
		const summary = formatDiagnostics(entries, filter);
		if (summary === "No matching LSP diagnostics.") return undefined;
		const key = `${filter}:${summary}`;
		if (key === lastTurnSummaryKey) return undefined;
		lastTurnSummaryKey = key;
		pi.sendMessage({ customType: "lsp-diagnostics", content: `LSP diagnostics after turn:\n${summary}`, display: true });
		return undefined;
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description: "Return cached LSP diagnostics. If path is provided, sync that file first. Diagnostics are cached and not injected after every edit.",
		parameters: diagnosticsToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let syncMessage: string | undefined;
			if (params.path) {
				syncMessage = await syncFile(ctx, params.path).catch((error) => `LSP sync failed: ${error?.message ?? error}`);
				await new Promise((resolve) => setTimeout(resolve, 3000));
			}
			const severity = ["error", "warning", "info", "hint", "all"].includes(String(params.severity)) ? (params.severity as SeverityFilter) : "all";
			let entries = getDiagnosticEntries(params.path, ctx.cwd);
			let fallbackMessage: string | undefined;
			if (params.path && diagnosticCounts(entries).total === 0) {
				fallbackMessage = await runCsharpBuildFallback(ctx, params.path).catch((error) => `dotnet build fallback failed: ${error?.message ?? error}`);
				entries = getDiagnosticEntries(params.path, ctx.cwd);
			}
			const prefix = [syncMessage, fallbackMessage].filter(Boolean).join("\n");
			const text = `${prefix ? `${prefix}\n\n` : ""}${formatDiagnostics(entries, severity)}`;
			return { content: [{ type: "text", text }], details: { diagnostics: entries, severity, fallbackMessage } };
		},
	});

	pi.registerCommand("lsp", {
		description: "Manage LSP support: /lsp [status|diagnostics [path]|restart|stop|config]",
		handler: async (args, ctx) => {
			statusCtx = ctx;
			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (command === "status") {
				ctx.ui.notify(formatStatus(), "info");
				setStatus(ctx);
				return;
			}
			if (command === "diagnostics") {
				const target = rest.join(" ").trim() || undefined;
				let syncMessage = "";
				if (target) syncMessage = `${await syncFile(ctx, target).catch((error) => `LSP sync failed: ${error?.message ?? error}`)}\n`;
				if (target) await new Promise((resolve) => setTimeout(resolve, 3000));
				let entries = getDiagnosticEntries(target, ctx.cwd);
				let fallbackMessage = "";
				if (target && diagnosticCounts(entries).total === 0) {
					fallbackMessage = `${await runCsharpBuildFallback(ctx, target).catch((error) => `dotnet build fallback failed: ${error?.message ?? error}`)}\n`;
					entries = getDiagnosticEntries(target, ctx.cwd);
				}
				ctx.ui.notify(`${syncMessage}${fallbackMessage}\n${formatDiagnostics(entries, "all")}`, "info");
				return;
			}
			if (command === "restart") {
				await stopAll();
				documents.clear();
				diagnostics.clear();
				warnings.clear();
				ctx.ui.notify("LSP servers stopped. They will restart lazily on the next matching file sync.", "info");
				setStatus(ctx);
				return;
			}
			if (command === "stop") {
				await stopAll();
				ctx.ui.notify("LSP servers stopped.", "info");
				return;
			}
			if (command === "config") {
				ctx.ui.notify(`Config path: ${CONFIG_PATH}\n${JSON.stringify(config, null, 2)}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /lsp [status|diagnostics [path]|restart|stop|config]", "warning");
		},
	});
}
