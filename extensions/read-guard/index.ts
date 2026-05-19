import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

type Mode = "stale" | "range" | "strict" | "off";

type ReadRecord = {
	filePath: string;
	hash: string;
	lineCount: number;
	ranges: Array<[start: number, end: number]>;
	fullRead: boolean;
	timestamp: number;
};

type PendingRead = {
	filePath: string;
	offset: number;
	limit?: number;
};

type PendingMutation = {
	filePath: string;
	fullWrite: boolean;
	baseHash?: string;
};

const DEFAULT_MODE: Mode = "stale";
const MODE_VALUES = new Set<Mode>(["stale", "range", "strict", "off"]);
const STATE_ENTRY = "read-guard-state";

const readRecords = new Map<string, ReadRecord>();
const pendingReads = new Map<string, PendingRead>();
const pendingMutations = new Map<string, PendingMutation>();

function getArgValue(name: string): string | undefined {
	const eqPrefix = `--${name}=`;
	for (let i = 0; i < process.argv.length; i++) {
		const arg = process.argv[i];
		if (arg === `--${name}`) return process.argv[i + 1];
		if (arg.startsWith(eqPrefix)) return arg.slice(eqPrefix.length);
	}
	return undefined;
}

function normalizeMode(value: unknown): Mode {
	if (value === "on") return "stale";
	return typeof value === "string" && MODE_VALUES.has(value as Mode) ? (value as Mode) : DEFAULT_MODE;
}

function resolvePath(cwd: string, inputPath: string): string {
	const expanded = inputPath === "~" || inputPath.startsWith("~/") ? path.join(process.env.HOME ?? "~", inputPath.slice(2)) : inputPath;
	return path.resolve(cwd, expanded);
}

function fileHash(filePath: string): string | undefined {
	try {
		return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch {
		return undefined;
	}
}

function countLines(content: string): number {
	if (content.length === 0) return 1;
	return content.split(/\r?\n/).length;
}

function countFileLines(filePath: string): number {
	try {
		return countLines(fs.readFileSync(filePath, "utf8"));
	} catch {
		return 1;
	}
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof (part as any).text === "string") return (part as any).text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	const sorted = ranges
		.map(([start, end]) => [Math.max(1, start), Math.max(start, end)] as [number, number])
		.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (!last || range[0] > last[1] + 1) merged.push([...range]);
		else last[1] = Math.max(last[1], range[1]);
	}
	return merged;
}

function isCovered(record: ReadRecord, touched: [number, number], requireFullRead: boolean): boolean {
	if (requireFullRead) return record.fullRead;
	const [start, end] = touched;
	return mergeRanges(record.ranges).some(([readStart, readEnd]) => readStart <= start && readEnd >= end);
}

function formatRanges(ranges: Array<[number, number]>): string {
	const merged = mergeRanges(ranges);
	if (merged.length === 0) return "none";
	return merged.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
}

function parsePositiveInt(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function getToolPath(input: any): string {
	return String(input?.path ?? input?.file_path ?? input?.filePath ?? "");
}

function findLineRangeForText(content: string, needle: string): [number, number] | undefined {
	if (!needle) return undefined;
	const index = content.indexOf(needle);
	if (index < 0) return undefined;
	if (content.indexOf(needle, index + needle.length) >= 0) return undefined;
	const before = content.slice(0, index);
	const start = countLines(before);
	const end = start + countLines(needle) - 1;
	return [start, Math.max(start, end)];
}

function touchedLinesForEdit(filePath: string, input: any): [number, number] | undefined {
	if (input?.oldRange?.start?.line) {
		const start = parsePositiveInt(input.oldRange.start.line);
		const end = parsePositiveInt(input.oldRange.end?.line) ?? start;
		if (start) return [start, Math.max(start, end ?? start)];
	}

	if (Array.isArray(input?.edits)) {
		const ranged: Array<[number, number]> = [];
		const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
		for (const edit of input.edits) {
			const rangeStart = parsePositiveInt(edit?.range?.start?.line);
			if (rangeStart) {
				const rangeEnd = parsePositiveInt(edit?.range?.end?.line) ?? rangeStart;
				ranged.push([rangeStart, Math.max(rangeStart, rangeEnd)]);
				continue;
			}
			const oldText = typeof edit?.oldText === "string" ? edit.oldText : undefined;
			const found = oldText ? findLineRangeForText(content, oldText) : undefined;
			if (found) ranged.push(found);
		}
		if (ranged.length > 0) return [Math.min(...ranged.map(([s]) => s)), Math.max(...ranged.map(([, e]) => e))];
	}

	const oldText = typeof input?.oldText === "string" ? input.oldText : undefined;
	if (oldText && fs.existsSync(filePath)) return findLineRangeForText(fs.readFileSync(filePath, "utf8"), oldText);
	return undefined;
}

function blockReason(kind: "unread" | "stale" | "range" | "full", tool: string, filePath: string, extra = ""): string {
	const readWhole = `read path=\"${filePath}\"`;
	return [
		`Read guard blocked ${tool} to ${filePath}.`,
		kind === "unread" ? "Reason: this existing file has not been read in this session." : undefined,
		kind === "stale" ? "Reason: the file changed outside this agent since it was last observed." : undefined,
		kind === "range" ? "Reason: the edit touches lines outside the ranges that were read." : undefined,
		kind === "full" ? "Reason: this operation requires a full current read." : undefined,
		extra || undefined,
		`Re-read with ${readWhole} and retry.`,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

function setStatus(ctx: ExtensionContext, mode: Mode) {
	ctx.ui.setStatus("read-guard", mode === "off" ? "📖 read-guard:off" : `📖 read-guard:${mode}`);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("read-guard", {
		description: "Read-before-edit guard mode: stale, range, strict, off (on aliases stale)",
		type: "string",
		default: DEFAULT_MODE,
	});

	const explicitModeArg = getArgValue("read-guard");
	let mode = normalizeMode(explicitModeArg ?? pi.getFlag("read-guard"));

	function persist() {
		pi.appendEntry(STATE_ENTRY, { mode, timestamp: Date.now() });
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!explicitModeArg) {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
					mode = normalizeMode((entry.data as { mode?: unknown }).mode ?? mode);
				}
			}
		}
		setStatus(ctx, mode);
	});

	pi.registerCommand("readguard", {
		description: "Configure read-before-edit guard: /readguard [stale|range|strict|off|status|reset] (`on` aliases `stale`)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				ctx.ui.notify(`Read guard: mode=${mode}, trackedFiles=${readRecords.size}`, "info");
				setStatus(ctx, mode);
				return;
			}
			if (trimmed === "reset") {
				readRecords.clear();
				pendingReads.clear();
				pendingMutations.clear();
				ctx.ui.notify("Read guard state reset", "info");
				return;
			}
			const requestedMode = normalizeMode(trimmed);
			if (trimmed === "on" || MODE_VALUES.has(trimmed as Mode)) {
				mode = requestedMode;
				persist();
				setStatus(ctx, mode);
				ctx.ui.notify(`Read guard set to ${mode}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /readguard [stale|range|strict|off|status|reset] (`on` aliases `stale`)", "warning");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "read") {
			const input = event.input as any;
			const filePathInput = getToolPath(input);
			if (filePathInput) {
				pendingReads.set(event.toolCallId, {
					filePath: resolvePath(ctx.cwd, filePathInput),
					offset: parsePositiveInt(input.offset) ?? 1,
					limit: parsePositiveInt(input.limit),
				});
			}
			return undefined;
		}

		if (mode === "off") return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

		const input = event.input as any;
		const filePathInput = getToolPath(input);
		if (!filePathInput) return undefined;
		const filePath = resolvePath(ctx.cwd, filePathInput);

		// New-file writes are safe: there is no existing content to preserve.
		if (!fs.existsSync(filePath)) {
			if (event.toolName === "write") {
				pendingMutations.set(event.toolCallId, { filePath, fullWrite: true });
			}
			return undefined;
		}

		const record = readRecords.get(filePath);
		if (!record) return { block: true, reason: blockReason("unread", event.toolName, filePath) };

		const currentHash = fileHash(filePath);
		if (!currentHash || currentHash !== record.hash) {
			return { block: true, reason: blockReason("stale", event.toolName, filePath) };
		}

		if (event.toolName === "write") {
			if (!record.fullRead) return { block: true, reason: blockReason("full", "write", filePath, `Read ranges so far: ${formatRanges(record.ranges)}`) };
			pendingMutations.set(event.toolCallId, { filePath, fullWrite: true, baseHash: currentHash });
			return undefined;
		}

		if (mode === "stale") {
			pendingMutations.set(event.toolCallId, { filePath, fullWrite: false, baseHash: currentHash });
			return undefined;
		}

		if (mode === "strict" && !record.fullRead) {
			return { block: true, reason: blockReason("full", "edit", filePath, `Read ranges so far: ${formatRanges(record.ranges)}`) };
		}

		const touched = touchedLinesForEdit(filePath, input);
		if (!touched) {
			pendingMutations.set(event.toolCallId, { filePath, fullWrite: false, baseHash: currentHash });
			return undefined;
		}

		if (!isCovered(record, touched, mode === "strict")) {
			return {
				block: true,
				reason: blockReason(
					mode === "strict" ? "full" : "range",
					"edit",
					filePath,
					`Touched lines: ${touched[0]}-${touched[1]}\nRead ranges so far: ${formatRanges(record.ranges)}`,
				),
			};
		}

		pendingMutations.set(event.toolCallId, { filePath, fullWrite: false, baseHash: currentHash });
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName === "read") {
			const pending = pendingReads.get(event.toolCallId);
			pendingReads.delete(event.toolCallId);
			if (!pending || event.isError) return undefined;

			const hash = fileHash(pending.filePath);
			if (!hash || !fs.existsSync(pending.filePath)) return undefined;

			const totalLines = countFileLines(pending.filePath);
			const text = textFromContent((event as any).content);
			const deliveredLines = Math.max(1, countLines(text));
			const start = pending.offset;
			const requestedEnd = pending.limit ? start + pending.limit - 1 : totalLines;
			const deliveredEnd = Math.min(totalLines, start + deliveredLines - 1, requestedEnd);
			const range: [number, number] = [start, Math.max(start, deliveredEnd)];

			const existing = readRecords.get(pending.filePath);
			const ranges = existing && existing.hash === hash ? [...existing.ranges, range] : [range];
			const fullRead = mergeRanges(ranges).some(([rangeStart, rangeEnd]) => rangeStart <= 1 && rangeEnd >= totalLines);

			readRecords.set(pending.filePath, {
				filePath: pending.filePath,
				hash,
				lineCount: totalLines,
				ranges,
				fullRead,
				timestamp: Date.now(),
			});

			return undefined;
		}

		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
		const pending = pendingMutations.get(event.toolCallId);
		pendingMutations.delete(event.toolCallId);
		if (!pending || event.isError) return undefined;

		const hash = fileHash(pending.filePath);
		if (!hash || !fs.existsSync(pending.filePath)) return undefined;

		const totalLines = countFileLines(pending.filePath);
		const existing = readRecords.get(pending.filePath);
		if (pending.baseHash && existing?.hash !== pending.baseHash) return undefined;

		const lineCountChanged = existing !== undefined && existing.lineCount !== totalLines;
		const fullRead = pending.fullWrite || existing?.fullRead === true;
		const ranges: Array<[number, number]> = fullRead ? [[1, totalLines]] : lineCountChanged ? [] : existing?.ranges ?? [];

		readRecords.set(pending.filePath, {
			filePath: pending.filePath,
			hash,
			lineCount: totalLines,
			ranges,
			fullRead,
			timestamp: Date.now(),
		});

		return undefined;
	});
}
