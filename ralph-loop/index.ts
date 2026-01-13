/// <reference path="./types.d.ts" />

/**
 * Ralph Loop Tool - Run subagent tasks in a loop.
 *
 * Executes subagent tasks (single, parallel, or chain) repeatedly while
 * a condition command returns "true".
 */

import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	AssistantMessageComponent,
	DynamicBorder,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_LINE_LIMIT = 30;

/**
 * Look up the provider for a model using `pi --list-models`.
 * Returns the first matching provider, or null if not found.
 */
function lookupProviderForModel(modelName: string): string | null {
	try {
		const result = spawnSync("pi", ["--list-models", modelName], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		
		if (result.status !== 0 || !result.stdout) return null;
		
		const lines = result.stdout.split("\n");
		// Skip header line, find exact match for model
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			
			// Parse columns: provider, model, context, max-out, thinking, images
			const parts = line.split(/\s+/);
			if (parts.length >= 2) {
				const provider = parts[0];
				const model = parts[1];
				// Return first provider where model matches exactly
				if (model === modelName) {
					return provider;
				}
			}
		}
		
		// If no exact match, return first result's provider (fuzzy match)
		if (lines.length > 1) {
			const firstResult = lines[1].trim().split(/\s+/);
			if (firstResult.length >= 2) {
				return firstResult[0];
			}
		}
		
		return null;
	} catch {
		return null;
	}
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "builtin" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionFile?: string; // Path to subagent's session file
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

interface LoopIterationResult {
	index: number;
	details: SubagentDetails;
	output: string;
	isError?: boolean;
}

interface LoopPromptItem {
	agent: string;
	task: string;
	model?: string;
	thinking?: string;
}

interface LoopPromptInfo {
	mode: "single" | "parallel" | "chain";
	items: LoopPromptItem[];
}

type LoopRunStatus = "idle" | "running" | "paused" | "stopping";

interface RalphLoopDetails {
	iterations: LoopIterationResult[];
	stopReason: string;
	conditionCommand: string;
	conditionSource: "provided" | "inferred" | "default";
	maxIterations: number | null;
	sleepMs: number;
	lastCondition: { stdout: string; stderr: string; exitCode: number };
	prompt: LoopPromptInfo;
	steering: string[];
	followUps: string[];
	steeringSent: string[];
	followUpsSent: string[];
	status: LoopRunStatus;
}

interface LoopControlState {
	status: LoopRunStatus;
	runId: string | null;
	iterations: number;
	steering: string[];
	steeringOnce: string[];
	followUps: string[];
	steeringSent: string[];
	followUpsSent: string[];
	paused: boolean;
	abortController: AbortController | null;
	lastDetails: RalphLoopDetails | null;
}

interface ActiveRun {
	process: any;
	sendFollowUp: (message: string) => Promise<void>;
	sendSteer: (message: string) => Promise<void>;
}

type ActiveRunRegistration = (run: ActiveRun) => () => void;

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> }
	| { type: "toolResult"; name: string; content: (TextContent | ImageContent)[]; isError: boolean };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		} else if (msg.role === "toolResult") {
			items.push({ type: "toolResult", name: msg.toolName, content: msg.content, isError: msg.isError });
		}
	}
	return items;
}

const BUILTIN_TOOL_NAMES = new Set(["bash", "read", "write", "edit", "ls", "find", "grep"]);

type LoopViewerEntry =
	| { type: "section"; text: string }
	| { type: "meta"; text: string }
	| { type: "note"; text: string }
	| { type: "user"; text: string }
	| { type: "assistant"; message: Message }
	| {
			type: "toolExecution";
			toolName: string;
			args: Record<string, any>;
			result: { content: (TextContent | ImageContent)[]; details?: any; isError: boolean; isPartial?: boolean };
		};

function buildEntryComponent(entry: LoopViewerEntry, theme: any, ui: any, cwd: string, expanded: boolean) {
	switch (entry.type) {
		case "section":
			return new Text(theme.fg("accent", entry.text), 1, 0);
		case "meta":
			return new Text(theme.fg("dim", entry.text), 1, 0);
		case "note":
			return new Text(theme.fg("muted", entry.text), 1, 0);
		case "user":
			return new UserMessageComponent(entry.text);
		case "assistant":
			return new AssistantMessageComponent(entry.message as any, true);
		case "toolExecution": {
			const isBuiltin = BUILTIN_TOOL_NAMES.has(entry.toolName);
			if (isBuiltin) {
				const toolComp = new ToolExecutionComponent(
					entry.toolName,
					entry.args,
					{ showImages: false },
					undefined,
					ui,
					cwd,
				);
				toolComp.updateResult(entry.result, Boolean(entry.result.isPartial));
				toolComp.setExpanded(expanded);
				return toolComp;
			}
			const argsText = JSON.stringify(entry.args ?? {}, null, 2);
			const output = extractTextFromContent(entry.result.content).trim();
			const container = new Container();
			const header = theme.fg("accent", entry.toolName);
			const argsLine = argsText && argsText !== "{}" ? theme.fg("dim", ` ${argsText}`) : "";
			container.addChild(new Text(header + argsLine, 1, 0));
			if (output) {
				const color = entry.result.isError ? "error" : "toolOutput";
				container.addChild(new Text(theme.fg(color, output), 1, 0));
			} else if (entry.result.isPartial) {
				container.addChild(new Text(theme.fg("dim", "(running...)"), 1, 0));
			}
			return container;
		}
	}
}

function renderLoopEntries(entries: LoopViewerEntry[], theme: any, tui: any, cwd: string, expanded: boolean) {
	const container = new Container();
	const toolUi = tui ?? { requestRender: () => {} };
	for (const entry of entries) {
		const component = buildEntryComponent(entry, theme, toolUi, cwd, expanded);
		if (component) {
			container.addChild(component);
			container.addChild(new Spacer(1));
		}
	}
	return container;
}

const LANGUAGE_OVERRIDES: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".json": "json",
	".md": "markdown",
	".yml": "yaml",
	".yaml": "yaml",
	".toml": "toml",
	".sh": "bash",
	".bash": "bash",
	".zsh": "bash",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".hxx": "cpp",
	".css": "css",
	".html": "html",
	".htm": "html",
	".sql": "sql",
	".rb": "ruby",
	".php": "php",
	".swift": "swift",
};

function getLanguageFromPath(filePath: string): string | null {
	const ext = path.extname(filePath).toLowerCase();
	return LANGUAGE_OVERRIDES[ext] ?? null;
}

function getLanguageForToolOutput(toolName: string, args: Record<string, any>): string | null {
	if (toolName === "bash") return "bash";
	const rawPath = (args.file_path || args.path) as string | undefined;
	if (!rawPath) return null;
	return getLanguageFromPath(rawPath);
}

function formatLoopEntriesText(loopDetails: RalphLoopDetails): string {
	const entries = buildLoopEntries(loopDetails);
	const themePlain = (_color: any, text: string) => text;
	const lines: string[] = ["## Ralph Loop Details"];

	for (const entry of entries) {
		switch (entry.type) {
			case "section":
				lines.push("", `### ${entry.text}`);
				break;
			case "meta":
			case "note":
				lines.push(`- ${entry.text}`);
				break;
			case "user":
				lines.push("", "**User:**", entry.text);
				break;
			case "assistant": {
				const text = extractTextFromContent(entry.message.content).trim();
				if (text) {
					lines.push("", "**Assistant:**", text);
				}
				break;
			}
			case "toolExecution": {
				const toolLine = formatToolCall(entry.toolName, entry.args, themePlain);
				lines.push("", `**Tool:** ${toolLine}`);
				const output = extractTextFromContent(entry.result.content).trim();
				if (output) {
					const language = getLanguageForToolOutput(entry.toolName, entry.args);
					lines.push(language ? `\`\`\`${language}` : "```", output, "```");
				} else if (entry.result.isPartial) {
					lines.push("_(running...)_");
				} else {
					lines.push("_(no output)_");
				}
				break;
			}
		}
	}

	return lines.join("\n").trim();
}

function truncateComponentLines(component: any, maxLines: number, theme: any) {
	return {
		render: (width: number) => {
			const lines = component.render(width);
			if (lines.length <= maxLines) return lines;
			const remaining = lines.length - maxLines;
			const notice = theme.fg("muted", `... (${remaining} earlier lines, Ctrl+O to expand)`);
			const truncated = lines.slice(Math.max(0, lines.length - maxLines));
			return [truncateToWidth(notice, width), ...truncated];
		},
		invalidate: () => {
			component.invalidate?.();
		},
	};
}

function buildLoopEntries(loopDetails: RalphLoopDetails): LoopViewerEntry[] {
	const entries: LoopViewerEntry[] = [];
	entries.push({ type: "meta", text: `Status: ${loopDetails.status}` });
	entries.push({ type: "meta", text: `Stop: ${loopDetails.stopReason}` });
	entries.push({ type: "meta", text: `Condition: ${loopDetails.conditionCommand} (${loopDetails.conditionSource})` });
	entries.push({ type: "meta", text: `Iterations: ${loopDetails.iterations.length}` });

	const appendQueuedEntries = () => {
		const hasQueued =
			loopDetails.steering.length > 0 ||
			loopDetails.followUps.length > 0 ||
			loopDetails.steeringSent.length > 0 ||
			loopDetails.followUpsSent.length > 0;
		if (!hasQueued) return;
		entries.push({ type: "section", text: "Queued Messages" });
		if (loopDetails.steering.length > 0) {
			entries.push({ type: "note", text: `Steering queued: ${loopDetails.steering.join(" | ")}` });
		}
		if (loopDetails.followUps.length > 0) {
			entries.push({ type: "note", text: `Follow-ups queued: ${loopDetails.followUps.join(" | ")}` });
		}
		if (loopDetails.steeringSent.length > 0) {
			entries.push({ type: "note", text: `Steering sent: ${loopDetails.steeringSent.join(" | ")}` });
		}
		if (loopDetails.followUpsSent.length > 0) {
			entries.push({ type: "note", text: `Follow-ups sent: ${loopDetails.followUpsSent.join(" | ")}` });
		}
	};

	if (loopDetails.iterations.length === 0) {
		entries.push({ type: "note", text: "(no iterations yet)" });
		appendQueuedEntries();
		return entries;
	}

	for (const iteration of loopDetails.iterations) {
		entries.push({ type: "section", text: `Iteration ${iteration.index} (${iteration.details.mode})` });

		for (const result of iteration.details.results) {
			const statusIcon = result.exitCode === 0 ? "✓" : "✗";
			const agentLine = `${statusIcon} ${result.agent} (${result.agentSource})`;
			entries.push({ type: "note", text: agentLine });
			if (result.task) entries.push({ type: "note", text: `Task: ${result.task}` });
			if (result.errorMessage) entries.push({ type: "note", text: `Error: ${result.errorMessage}` });

			const toolCalls = new Map<string, { name: string; args: Record<string, any> }>();
			for (const msg of result.messages) {
				if (msg.role === "assistant") {
					for (const part of msg.content) {
						if (part.type === "toolCall") {
							toolCalls.set(part.id, { name: part.name, args: part.arguments });
						}
					}
					entries.push({ type: "assistant", message: msg });
				} else if (msg.role === "user") {
					const text = extractTextFromContent(msg.content).trim();
					entries.push({ type: "user", text: text || "(user message)" });
				} else if (msg.role === "toolResult") {
					const toolCall = toolCalls.get(msg.toolCallId);
					entries.push({
						type: "toolExecution",
						toolName: msg.toolName,
						args: toolCall?.args ?? {},
						result: {
							content: msg.content,
							details: msg.details,
							isError: msg.isError,
							isPartial: msg.isPartial,
						},
					});
				}
			}

			if (result.messages.length === 0) {
				entries.push({ type: "note", text: "(no messages)" });
			}
		}
	}

	appendQueuedEntries();
	return entries;
}

function formatTaskPreview(task: string, maxLength: number): string {
	const singleLine = task.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, maxLength)}...`;
}

function formatSteeringText(messages: string[]): string | null {
	const cleaned = messages.map((msg) => msg.trim()).filter(Boolean);
	if (cleaned.length === 0) return null;
	const lines = cleaned.map((msg, index) => `${index + 1}. ${msg}`);
	return `Steering updates:\n${lines.join("\n")}`;
}

function appendSteeringToTask(task: string, steering: string | null): string {
	if (!steering) return task;
	return `${task.trim()}\n\n${steering}`;
}

function cloneLoopParams(params: any): any {
	return {
		...params,
		tasks: Array.isArray(params.tasks) ? params.tasks.map((task: any) => ({ ...task })) : undefined,
		chain: Array.isArray(params.chain) ? params.chain.map((step: any) => ({ ...step })) : undefined,
	};
}

function applySteeringToParams(params: any, steering: string | null): any {
	const nextParams = cloneLoopParams(params);
	if (!steering) return nextParams;
	if (typeof nextParams.task === "string") {
		nextParams.task = appendSteeringToTask(nextParams.task, steering);
	}
	if (Array.isArray(nextParams.tasks)) {
		nextParams.tasks = nextParams.tasks.map((task: any) => ({
			...task,
			task: appendSteeringToTask(task.task, steering),
		}));
	}
	if (Array.isArray(nextParams.chain)) {
		nextParams.chain = nextParams.chain.map((step: any) => ({
			...step,
			task: appendSteeringToTask(step.task, steering),
		}));
	}
	return nextParams;
}

function mergeAbortSignals(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal | undefined {
	if (!primary) return secondary;
	if (!secondary) return primary;
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (primary.aborted || secondary.aborted) {
		controller.abort();
	} else {
		primary.addEventListener("abort", abort, { once: true });
		secondary.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}

function isProcessActive(proc: any): boolean {
	return Boolean(proc && proc.exitCode === null);
}

function pauseActiveRuns(control: LoopControlState, runs: Set<ActiveRun>): boolean {
	if (control.paused) return runs.size > 0;
	let paused = false;
	for (const run of runs) {
		try {
			if (isProcessActive(run.process)) {
				const didStop = run.process.kill("SIGSTOP");
				if (didStop) paused = true;
			}
		} catch {
			// ignore
		}
	}
	if (paused) {
		control.paused = true;
		if (control.status !== "stopping") {
			control.status = "paused";
		}
	}
	return paused;
}

function clearPausedState(control: LoopControlState): void {
	if (!control.paused) return;
	control.paused = false;
	if (control.status === "paused") {
		control.status = "running";
	}
}

function resumeActiveRuns(control: LoopControlState, runs: Set<ActiveRun>): boolean {
	if (!control.paused) return runs.size > 0;
	if (runs.size === 0) {
		clearPausedState(control);
		return true;
	}
	let resumed = false;
	for (const run of runs) {
		try {
			if (isProcessActive(run.process)) {
				const didResume = run.process.kill("SIGCONT");
				if (didResume) resumed = true;
			}
		} catch {
			// ignore
		}
	}
	if (resumed) {
		clearPausedState(control);
	}
	return resumed;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	modelOverride?: string,
	thinkingLevel?: string,
	taskIndex?: number,
	registerActiveRun?: ActiveRunRegistration,
	initialFollowUps?: string[],
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: ${agentName}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Use model override if provided, otherwise fall back to agent's model
	const effectiveModel = modelOverride || agent.model;

	// Create session file for this subagent invocation
	const subagentSessionDir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
	if (!fs.existsSync(subagentSessionDir)) {
		fs.mkdirSync(subagentSessionDir, { recursive: true });
	}
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	// Use UUID for guaranteed uniqueness, especially important for parallel execution
	const uuid = crypto.randomUUID().substring(0, 8);
	const indexSuffix = taskIndex !== undefined ? `_idx${taskIndex}` : "";
	const stepSuffix = step !== undefined ? `_step${step}` : "";
	const sessionFile = path.join(subagentSessionDir, `${timestamp}_${safeName}${stepSuffix}${indexSuffix}_${uuid}.jsonl`);

	const args: string[] = ["--mode", "rpc", "--session", sessionFile];

	// Parse provider:model format and pass both --provider and --model flags
	// This is needed because pi's --model flag alone doesn't override defaultProvider from settings.json
	if (effectiveModel) {
		if (effectiveModel.includes(":")) {
			const colonIndex = effectiveModel.indexOf(":");
			const provider = effectiveModel.slice(0, colonIndex);
			const model = effectiveModel.slice(colonIndex + 1);
			args.push("--provider", provider, "--model", model);
		} else {
			// Look up the provider for this model
			const provider = lookupProviderForModel(effectiveModel);
			if (provider) {
				args.push("--provider", provider, "--model", effectiveModel);
			} else {
				args.push("--model", effectiveModel);
			}
		}
	}
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	// Add custom tools from agent configuration (e.g., question tool for planners)
	if (agent.customTools && agent.customTools.length > 0) {
		const optionalToolsDir = path.join(os.homedir(), ".pi", "agent", "tools-optional");
		for (const toolRef of agent.customTools) {
			// Support both tool names (looked up in tools-optional) and full paths
			let toolPath = toolRef;
			if (!path.isAbsolute(toolRef) && !toolRef.startsWith("~")) {
				toolPath = path.join(optionalToolsDir, toolRef, "index.ts");
			} else if (toolRef.startsWith("~")) {
				toolPath = path.join(os.homedir(), toolRef.slice(1));
			}
			if (fs.existsSync(toolPath)) {
				args.push("--tool", toolPath);
			}
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		step,
		sessionFile,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const env = agent.permissionLevel
				? { ...process.env, PI_PERMISSION_LEVEL: agent.permissionLevel }
				: process.env;
			const proc = spawn("pi", args, { cwd: cwd ?? defaultCwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
			let buffer = "";
			let resolved = false;
			let unregisterActive: (() => void) | null = null;
			let requestId = 0;
			const pending = new Map<string, { resolve: (response: any) => void; reject: (error: Error) => void }>();
			let stdinClosed = false;

			const rejectPending = (error: Error) => {
				for (const pendingReq of pending.values()) {
					try {
						pendingReq.reject(error);
					} catch {
						// ignore
					}
				}
				pending.clear();
			};

			const markStdinClosed = (error: Error) => {
				if (stdinClosed) return;
				stdinClosed = true;
				rejectPending(error);
			};

			proc.stdin?.on("error", (error) => {
				markStdinClosed(error instanceof Error ? error : new Error("stdin error"));
			});
			proc.stdin?.on("close", () => {
				markStdinClosed(new Error("stdin closed"));
			});

			const resolveOnce = (code: number) => {
				if (resolved) return;
				resolved = true;
				if (unregisterActive) unregisterActive();
				resolve(code);
			};

			const sendCommand = (command: any) =>
				new Promise<any>((resolveCommand, rejectCommand) => {
					if (stdinClosed || proc.exitCode !== null || proc.stdin?.destroyed) {
						rejectCommand(new Error("RPC process is not available"));
						return;
					}
					const id = `req_${++requestId}`;
					const payload = { ...command, id };
					const timeout = setTimeout(() => {
						if (pending.has(id)) {
							pending.delete(id);
							rejectCommand(new Error(`Timeout waiting for ${command.type}`));
						}
					}, 30000);

					pending.set(id, {
						resolve: (response) => {
							clearTimeout(timeout);
							resolveCommand(response);
						},
						reject: (error) => {
							clearTimeout(timeout);
							rejectCommand(error);
						},
					});

					try {
						proc.stdin?.write(`${JSON.stringify(payload)}\n`);
					} catch (error: any) {
						pending.delete(id);
						const err = error instanceof Error ? error : new Error(String(error));
						markStdinClosed(err);
						rejectCommand(err);
					}
				});

			const sendFollowUp = (message: string) => sendCommand({ type: "follow_up", message });
			const sendSteer = (message: string) => sendCommand({ type: "steer", message });
			unregisterActive = registerActiveRun
				? registerActiveRun({ process: proc, sendFollowUp, sendSteer })
				: null;

			const handleResponse = (event: any) => {
				const id = event?.id as string | undefined;
				if (!id) return false;
				const pendingReq = pending.get(id);
				if (!pendingReq) return false;
				pending.delete(id);
				if (event.success === false) {
					pendingReq.reject(new Error(event.error || "RPC command failed"));
				} else {
					pendingReq.resolve(event);
				}
				return true;
			};

			let finalizing = false;
			const finalizeRun = async () => {
				if (resolved || finalizing) return;
				finalizing = true;
				try {
					const response = await sendCommand({ type: "get_state" });
					const state = response?.data;
					if (state?.pendingMessageCount > 0 || state?.isStreaming) {
						finalizing = false;
						return;
					}
				} catch {
					// ignore
				}
				if (resolved) return;
				resolveOnce(0);
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 2000);
			};

			const upsertToolResult = (
				toolCallId: string,
				toolName: string,
				result: any,
				isError: boolean,
				isPartial: boolean,
			) => {
				const existingIndex = currentResult.messages.findIndex(
					(msg: any) => msg.role === "toolResult" && msg.toolCallId === toolCallId,
				);
				const existing = existingIndex >= 0 ? (currentResult.messages[existingIndex] as any) : null;
				const toolMessage = {
					role: "toolResult",
					toolCallId,
					toolName: toolName || existing?.toolName || "",
					content: result?.content || [],
					details: result?.details,
					isError,
					isPartial,
					timestamp: Date.now(),
				};
				if (existingIndex >= 0) {
					currentResult.messages[existingIndex] = { ...existing, ...toolMessage } as Message;
				} else {
					currentResult.messages.push(toolMessage as Message);
				}
				emitUpdate();
			};

			const processEvent = (event: any) => {
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
					return;
				}

				if (event.type === "tool_execution_start" && event.toolCallId) {
					upsertToolResult(event.toolCallId, event.toolName || "", { content: [], details: undefined }, false, true);
					return;
				}

				if (event.type === "tool_execution_update" && event.toolCallId) {
					const partial = event.partialResult ?? { content: [], details: undefined };
					upsertToolResult(event.toolCallId, event.toolName || "", partial, false, true);
					return;
				}

				if (event.type === "tool_execution_end" && event.toolCallId) {
					const result = event.result ?? { content: [], details: undefined };
					upsertToolResult(event.toolCallId, event.toolName || "", result, Boolean(event.isError), false);
					return;
				}

				if (event.type === "agent_end") {
					if (Array.isArray(event.messages)) {
						currentResult.messages = event.messages as Message[];
					}
					emitUpdate();
					void finalizeRun();
				}
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "response" && handleResponse(event)) {
					return;
				}

				processEvent(event);
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				markStdinClosed(new Error("process closed"));
				resolveOnce(code ?? 0);
			});

			proc.on("error", () => {
				markStdinClosed(new Error("process error"));
				resolveOnce(1);
			});

			if (signal) {
				const abortRpc = () => {
					wasAborted = true;
					sendCommand({ type: "abort" }).catch(() => undefined);
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) abortRpc();
				else signal.addEventListener("abort", abortRpc, { once: true });
			}

			sendCommand({ type: "prompt", message: `Task: ${task}` })
				.then(() => {
					const followUps = (initialFollowUps ?? []).filter((msg) => msg.trim().length > 0);
					if (followUps.length === 0) return;
					const queueFollowUps = async () => {
						for (const message of followUps) {
							try {
								await sendCommand({ type: "follow_up", message });
							} catch (error: any) {
								const errorMessage = error?.message ? `\n${error.message}` : `\n${String(error)}`;
								currentResult.stderr += errorMessage;
							}
						}
					};
					void queueFollowUps();
				})
				.catch((error) => {
					currentResult.stderr += error?.message ? `\n${error.message}` : String(error);
					resolveOnce(1);
					proc.kill("SIGTERM");
				});
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const ThinkingLevel = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
	description: "Thinking/reasoning level for the model",
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Override the agent's model (e.g., 'claude-opus-4-5', 'gpt-5.2-codex')" })),
	thinking: Type.Optional(ThinkingLevel),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Override the agent's model (e.g., 'claude-opus-4-5', 'gpt-5.2-codex')" })),
	thinking: Type.Optional(ThinkingLevel),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(Type.String({ description: "Override the agent's model for single mode (e.g., 'claude-opus-4-5', 'gpt-5.2-codex')" })),
	thinking: Type.Optional(ThinkingLevel),
});

const DEFAULT_LOOP_MAX_ITERATIONS = Number.MAX_SAFE_INTEGER;
const DEFAULT_LOOP_SLEEP_MS = 1000;

const LoopParams = Type.Object({
	conditionCommand: Type.Optional(
		Type.String({
			description:
				"Bash command used for looping; continue while stdout is 'true' (case-insensitive). If omitted, inferred from task or defaults to 'echo true'.",
		}),
	),
	maxIterations: Type.Optional(Type.Number({ description: "Max iterations (optional)." })),
	sleepMs: Type.Optional(Type.Number({ description: `Sleep between iterations in ms (default ${DEFAULT_LOOP_SLEEP_MS}).` })),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(Type.String({ description: "Override the agent's model for single mode (e.g., 'claude-opus-4-5', 'gpt-5.2-codex')" })),
	thinking: Type.Optional(ThinkingLevel),
});

interface LoopExecutionResult {
	output: string;
	details: SubagentDetails;
	isError?: boolean;
}

async function executeSubagentOnce(
	params: any,
	ctx: any,
	signal?: AbortSignal,
	onUpdate?: OnUpdateCallback,
	registerActiveRun?: ActiveRunRegistration,
	initialFollowUps?: string[],
): Promise<LoopExecutionResult> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

	const makeDetails =
		(mode: "single" | "parallel" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		});

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			output: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
			details: makeDetails("single")([]),
			isError: true,
		};
	}

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a: AgentConfig | undefined): a is AgentConfig => a?.source === "project");

		if (projectAgentsRequested.length > 0) {
			const names = projectAgentsRequested.map((a) => a.name).join(", ");
			const dir = discovery.projectAgentsDir ?? "(unknown)";
			const ok = await ctx.ui.confirm(
				"Run project-local agents?",
				`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok)
				return {
					output: "Canceled: project-local agents not approved.",
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					isError: true,
				};
		}
	}

	if (params.chain && params.chain.length > 0) {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						const allResults = [...results, currentResult];
						onUpdate({
							content: partial.content,
							details: makeDetails("chain")(allResults),
						});
					}
				}
				: undefined;

			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				step.agent,
				taskWithContext,
				step.cwd,
				i + 1,
				signal,
				chainUpdate,
				makeDetails("chain"),
				step.model,
				step.thinking ?? params.thinking,
				undefined,
				registerActiveRun,
				initialFollowUps,
			);
			results.push(result);

			const isError =
				result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					output: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
					details: makeDetails("chain")(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}

		const stepOutputs = results.map((r, idx) => {
			const output = getFinalOutput(r.messages);
			const status = r.exitCode === 0 ? "✓" : "✗";
			return `Step ${idx + 1} [${r.agent}] ${status}:\n${output || "(no output)"}`;
		});

		const finalResult = `Chain completed (${results.length} steps)\n\n${"=".repeat(80)}\n\n${stepOutputs.join(
			`\n\n${"=".repeat(80)}\n\n`,
		)}\n\n${"=".repeat(80)}\n\nFinal output:\n${previousOutput}`;

		return {
			output: finalResult,
			details: makeDetails("chain")(results),
		};
	}

	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > MAX_PARALLEL_TASKS)
			return {
				output: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				details: makeDetails("parallel")([]),
				isError: true,
			};

		let allResults: SingleResult[] | null = null;
		const emitParallelUpdate = () => {
			if (!onUpdate || !allResults) return;
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			onUpdate({
				content: [
					{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
				],
				details: makeDetails("parallel")([...allResults]),
			});
		};

		if (onUpdate) {
			allResults = new Array(params.tasks.length);
			for (let i = 0; i < params.tasks.length; i++) {
				allResults[i] = {
					agent: params.tasks[i].agent,
					agentSource: "unknown",
					task: params.tasks[i].task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						contextTokens: 0,
						turns: 0,
					},
				};
			}
			emitParallelUpdate();
		}

		const results = await mapWithConcurrencyLimit(
			params.tasks,
			MAX_CONCURRENCY,
			async (t: any, index: number) => {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					t.agent,
					t.task,
					t.cwd,
					undefined,
					signal,
					onUpdate
						? (partial) => {
							if (partial.details?.results[0] && allResults) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						}
						: undefined,
					makeDetails("parallel"),
					t.model,
					t.thinking ?? params.thinking,
					index,
					registerActiveRun,
					initialFollowUps,
				);
				if (allResults) {
					allResults[index] = result;
					emitParallelUpdate();
				}
				return result;
			},
		);

		const successCount = results.filter((r) => r.exitCode === 0).length;
		const fullOutputs = results.map((r) => {
			const output = getFinalOutput(r.messages);
			const status = r.exitCode === 0 ? "✓ completed" : "✗ failed";
			return `[${r.agent}] ${status}:\n${output || "(no output)"}`;
		});

		return {
			output: `Parallel execution: ${successCount}/${results.length} succeeded\n\n${"=".repeat(80)}\n\n${fullOutputs.join(
				`\n\n${"=".repeat(80)}\n\n`,
			)}`,
			details: makeDetails("parallel")(results),
		};
	}

	if (params.agent && params.task) {
		const result = await runSingleAgent(
			ctx.cwd,
			agents,
			params.agent,
			params.task,
			params.cwd,
			undefined,
			signal,
			onUpdate,
			makeDetails("single"),
			params.model,
			params.thinking,
			undefined,
			registerActiveRun,
			initialFollowUps,
		);
		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		if (isError) {
			const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
			return {
				output: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
				details: makeDetails("single")([result]),
				isError: true,
			};
		}
		return {
			output: getFinalOutput(result.messages) || "(no output)",
			details: makeDetails("single")([result]),
		};
	}

	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		output: `Invalid parameters. Available agents: ${available}`,
		details: makeDetails("single")([]),
		isError: true,
	};
}

function parseLoopNumber(value: string | null, fallback: number, allowZero = false): number | null {
	const trimmed = value?.trim();
	if (!trimmed) return fallback;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed)) return null;
	if (parsed < 0) return null;
	if (!allowZero && parsed === 0) return null;
	return parsed;
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, delayMs);
		if (signal) {
			const cancel = () => {
				clearTimeout(timer);
				resolve();
			};
			if (signal.aborted) cancel();
			else signal.addEventListener("abort", cancel, { once: true });
		}
	});
}

async function checkLoopCondition(
	pi: ExtensionAPI,
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ shouldContinue: boolean; stdout: string; stderr: string; exitCode: number }> {
	const result = await pi.exec("bash", ["-lc", command], { cwd, signal });
	const stdout = (result.stdout || "").trim();
	const shouldContinue = stdout.toLowerCase() === "true";
	return {
		shouldContinue,
		stdout,
		stderr: result.stderr || "",
		exitCode: result.code ?? 0,
	};
}

async function confirmProjectAgentsOnce(params: any, ctx: any): Promise<boolean> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	if (agentScope === "user" || !ctx.hasUI) return true;

	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const requestedAgentNames = new Set<string>();
	if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
	if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
	if (params.agent) requestedAgentNames.add(params.agent);

	const projectAgentsRequested = Array.from(requestedAgentNames)
		.map((name) => agents.find((a) => a.name === name))
		.filter((a: AgentConfig | undefined): a is AgentConfig => a?.source === "project");

	if (projectAgentsRequested.length === 0) return true;

	const names = projectAgentsRequested.map((a) => a.name).join(", ");
	const dir = discovery.projectAgentsDir ?? "(unknown)";
	return ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
}

function extractTextFromContent(content: any): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function getLastUserText(ctx: any): string | null {
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "user") continue;
		const text = extractTextFromContent(msg.content);
		if (text.trim()) return text.trim();
	}
	return null;
}

function pickDefaultAgent(agents: AgentConfig[]): string | null {
	if (agents.length === 0) return null;
	const worker = agents.find((a) => a.name === "worker");
	return worker?.name ?? agents[0].name;
}

function inferConditionCommandFromText(text: string | undefined): string | null {
	if (!text) return null;
	const lines = text.split("\n");
	for (const line of lines) {
		const match = line.match(/^(?:\s*)(?:condition|exit condition|loop condition)\s*:\s*(.+)$/i);
		if (match) return match[1].trim();
	}
	const backtick = text.match(/\b(?:until|while)\s+`([^`]+)`/i);
	if (backtick) return backtick[1].trim();
	const inline = text.match(/\b(?:until|while)\s+([^\n.]+)$/i);
	if (inline) return inline[1].replace(/[.?!]$/, "").trim();
	return null;
}

function buildLoopPromptInfo(params: any): LoopPromptInfo {
	if (Array.isArray(params.chain) && params.chain.length > 0) {
		return {
			mode: "chain",
			items: params.chain.map((step: any) => ({
				agent: step.agent,
				task: step.task,
				model: step.model,
				thinking: step.thinking,
			})),
		};
	}
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return {
			mode: "parallel",
			items: params.tasks.map((task: any) => ({
				agent: task.agent,
				task: task.task,
				model: task.model,
				thinking: task.thinking,
			})),
		};
	}
	return {
		mode: "single",
		items: [
			{
				agent: params.agent || "(auto)",
				task: params.task || "",
				model: params.model,
				thinking: params.thinking,
			},
		],
	};
}

function formatLoopPromptItem(item: LoopPromptItem, maxTaskLength: number): string {
	const overrides: string[] = [];
	if (item.model) overrides.push(item.model);
	if (item.thinking) overrides.push(`thinking:${item.thinking}`);
	const overrideText = overrides.length > 0 ? ` (${overrides.join(", ")})` : "";
	const task = item.task || "";
	const preview = task.length > maxTaskLength ? `${task.slice(0, maxTaskLength)}...` : task;
	return `${item.agent}${overrideText}${preview ? ` ${preview}` : ""}`;
}

export default function (pi: ExtensionAPI) {
	const loopControl: LoopControlState = {
		status: "idle",
		runId: null,
		iterations: 0,
		steering: [],
		steeringOnce: [],
		followUps: [],
		steeringSent: [],
		followUpsSent: [],
		paused: false,
		abortController: null,
		lastDetails: null,
	};

	const activeRuns = new Set<ActiveRun>();
	const registerActiveRun: ActiveRunRegistration = (run) => {
		activeRuns.add(run);
		return () => activeRuns.delete(run);
	};

	const sendFollowUpToActive = async (message: string) => {
		const runs = Array.from(activeRuns);
		if (runs.length === 0) return false;
		let delivered = false;
		await Promise.all(
			runs.map(async (run) => {
				try {
					await run.sendFollowUp(message);
					delivered = true;
				} catch {
					// ignore
				}
			}),
		);
		return delivered;
	};

	const sendSteerToActive = async (message: string) => {
		const runs = Array.from(activeRuns);
		if (runs.length === 0) return false;
		let delivered = false;
		await Promise.all(
			runs.map(async (run) => {
				try {
					await run.sendSteer(message);
					delivered = true;
				} catch {
					// ignore
				}
			}),
		);
		return delivered;
	};

	const getLoopStatusLine = () => {
		if (loopControl.status === "idle") return undefined;
		const details = loopControl.lastDetails;
		const iterations = details?.iterations.length ?? loopControl.iterations;
		const maxIterations = details?.maxIterations;
		const maxLabel =
			typeof maxIterations === "number" && maxIterations !== Number.MAX_SAFE_INTEGER ? `/${maxIterations}` : "";
		return `ralph-loop ${loopControl.status}: ${iterations}${maxLabel}`;
	};

	const ensureActiveLoop = (ctx: any) => {
		if (loopControl.status === "idle") {
			ctx.ui.notify("No active ralph_loop run.", "warning");
			return false;
		}
		return true;
	};

	pi.registerCommand("ralph-steer", {
		description: "Queue a steering message for the active ralph_loop run",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;

			let message = args.trim();
			let once = false;
			if (message.startsWith("--once ")) {
				once = true;
				message = message.slice("--once ".length).trim();
			}
			if (!message) {
				const input = await ctx.ui.input("Steer ralph_loop:", "Add guidance for next iterations");
				if (!input) return;
				message = input.trim();
			}
			if (!message) return;

			const sentToActive = await sendSteerToActive(message);
			if (sentToActive) {
				loopControl.steeringSent.push(message);
			} else {
				if (once) {
					loopControl.steeringOnce.push(message);
				} else {
					loopControl.steering.push(message);
				}
			}

			if (sentToActive) {
				ctx.ui.notify("Queued for current iteration.", "info");
			} else {
				ctx.ui.notify(once ? "One-off steering queued for next iteration." : "Steering queued for next iteration.", "info");
			}
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-follow", {
		description: "Queue a follow-up message for the active ralph_loop run",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;

			let message = args.trim();
			if (!message) {
				const input = await ctx.ui.input("Follow up ralph_loop:", "Queue a follow-up message");
				if (!input) return;
				message = input.trim();
			}
			if (!message) return;

			const sentToActive = await sendFollowUpToActive(message);
			if (sentToActive) {
				loopControl.followUpsSent.push(message);
				ctx.ui.notify("Queued for current iteration.", "info");
			} else {
				loopControl.followUps.push(message);
				ctx.ui.notify("Follow-up queued for next iteration.", "info");
			}
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-clear", {
		description: "Clear queued steering for ralph_loop",
		handler: async (_args, ctx) => {
			loopControl.steering = [];
			loopControl.steeringOnce = [];
			ctx.ui.notify("Cleared steering queue.", "info");
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-pause", {
		description: "Pause the currently running ralph_loop iteration",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;
			if (loopControl.paused) {
				ctx.ui.notify("ralph_loop is already paused.", "info");
				return;
			}
			const paused = pauseActiveRuns(loopControl, activeRuns);
			if (!paused) {
				ctx.ui.notify("No running iteration to pause.", "warning");
				return;
			}
			ctx.ui.notify("Paused current iteration.", "info");
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-resume", {
		description: "Resume a paused ralph_loop",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;
			if (!loopControl.paused) {
				ctx.ui.notify("ralph_loop is not paused.", "info");
				return;
			}
			const hadRuns = activeRuns.size > 0;
			const resumed = resumeActiveRuns(loopControl, activeRuns);
			if (!resumed) {
				ctx.ui.notify("No paused iteration to resume.", "warning");
				return;
			}
			ctx.ui.notify(hadRuns ? "Resumed current iteration." : "Cleared paused state.", "info");
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop the active ralph_loop run",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;
			loopControl.status = "stopping";
			loopControl.abortController?.abort();
			resumeActiveRuns(loopControl, activeRuns);
			ctx.ui.notify("Stop requested for ralph_loop.", "warning");
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-status", {
		description: "Show ralph_loop status",
		handler: async (_args, ctx) => {
			const details = loopControl.lastDetails;
			if (loopControl.status === "idle" && !details) {
				ctx.ui.notify("No ralph_loop activity yet.", "info");
				return;
			}
			const iterations = details?.iterations.length ?? loopControl.iterations;
			const maxIterations = details?.maxIterations;
			const maxLabel =
				typeof maxIterations === "number" && maxIterations !== Number.MAX_SAFE_INTEGER ? `/${maxIterations}` : "";
			const steeringCount = loopControl.steering.length + loopControl.steeringOnce.length;
			const followUpCount = loopControl.followUps.length;
			const parts = [`Status: ${loopControl.status}`];
			if (loopControl.runId) parts.push(`Run: ${loopControl.runId}`);
			parts.push(`Iterations: ${iterations}${maxLabel}`);
			if (loopControl.status === "idle" && details?.stopReason) parts.push(`Last stop: ${details.stopReason}`);
			if (steeringCount > 0) parts.push(`Steering queued: ${steeringCount}`);
			if (followUpCount > 0) parts.push(`Follow-ups queued: ${followUpCount}`);
			ctx.ui.notify(parts.join(" | "), "info");
		},
	});

	pi.registerTool({
		name: "ralph_loop",
		label: "Ralph Loop",
		description: [
			"Run subagent tasks in a loop while a condition command prints 'true' to continue (anything else stops).",
			"Supports single, parallel, and chain modes.",
			"Supports model/thinking overrides like subagent.",
			"Defaults to agent 'worker' and the latest user message when agent/task are omitted.",
			"If conditionCommand is omitted, it is inferred from the task text or defaults to 'echo true'.",
		].join(" "),
		parameters: LoopParams,

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const emptyPrompt: LoopPromptInfo = { mode: "single", items: [] };

			const buildDetails = (overrides: Partial<RalphLoopDetails>): RalphLoopDetails => ({
				iterations: [],
				stopReason: "invalid-params",
				conditionCommand: "",
				conditionSource: "default",
				maxIterations: DEFAULT_LOOP_MAX_ITERATIONS,
				sleepMs: DEFAULT_LOOP_SLEEP_MS,
				lastCondition: { stdout: "", stderr: "", exitCode: 0 },
				prompt: emptyPrompt,
				steering: [...loopControl.steering, ...loopControl.steeringOnce],
				followUps: [...loopControl.followUps],
				steeringSent: [...loopControl.steeringSent],
				followUpsSent: [...loopControl.followUpsSent],
				status: loopControl.status,
				...overrides,
			});

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "ralph_loop aborted." }],
					details: buildDetails({ stopReason: "aborted" }),
					isError: true,
				};
			}

			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No agents available for the selected scope." }],
					details: buildDetails({ stopReason: "no-agents" }),
					isError: true,
				};
			}

			const loopParams: any = { ...params, agentScope };
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent || params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount > 1) {
				return {
					content: [{ type: "text", text: "Provide exactly one mode (single, parallel, or chain)." }],
					details: buildDetails({ stopReason: "invalid-params" }),
					isError: true,
				};
			}

			if (!hasChain && !hasTasks && !hasSingle) {
				const inferredTask = getLastUserText(ctx);
				const defaultAgent = pickDefaultAgent(agents);
				if (!inferredTask || !defaultAgent) {
					return {
						content: [
							{
								type: "text",
								text: "Unable to infer task or agent. Provide agent/task, tasks, or chain.",
							},
						],
						details: buildDetails({ stopReason: "missing-task" }),
						isError: true,
					};
				}
				loopParams.agent = defaultAgent;
				loopParams.task = inferredTask;
			}

			if (hasSingle) {
				if (!loopParams.agent) {
					const defaultAgent = pickDefaultAgent(agents);
					if (!defaultAgent) {
						return {
							content: [{ type: "text", text: "No agents available for the selected scope." }],
							details: buildDetails({ stopReason: "no-agents" }),
							isError: true,
						};
					}
					loopParams.agent = defaultAgent;
				}
				if (!loopParams.task) {
					const inferredTask = getLastUserText(ctx);
					if (!inferredTask) {
						return {
							content: [{ type: "text", text: "Unable to infer task. Provide a task." }],
							details: buildDetails({ stopReason: "missing-task" }),
							isError: true,
						};
					}
					loopParams.task = inferredTask;
				}
			}

			const sessionThinking = pi.getThinkingLevel();
			if (loopParams.thinking === undefined) {
				loopParams.thinking = sessionThinking;
			}
			if (Array.isArray(loopParams.chain)) {
				loopParams.chain = loopParams.chain.map((step: any) => ({
					...step,
					thinking: step.thinking ?? loopParams.thinking,
				}));
			}
			if (Array.isArray(loopParams.tasks)) {
				loopParams.tasks = loopParams.tasks.map((task: any) => ({
					...task,
					thinking: task.thinking ?? loopParams.thinking,
				}));
			}

			const promptInfo = buildLoopPromptInfo(loopParams);

			const conditionCandidate =
				typeof params.conditionCommand === "string" && params.conditionCommand.trim()
					? params.conditionCommand.trim()
					: null;

			let conditionSource: "provided" | "inferred" | "default" = "default";
			let conditionCommand = conditionCandidate || "";
			if (conditionCandidate) {
				conditionSource = "provided";
			} else {
				let textForInference: string | undefined;
				if (typeof loopParams.task === "string") textForInference = loopParams.task;
				else if (Array.isArray(loopParams.chain) && loopParams.chain.length > 0) textForInference = loopParams.chain[0].task;
				else if (Array.isArray(loopParams.tasks) && loopParams.tasks.length > 0) textForInference = loopParams.tasks[0].task;
				const inferred = inferConditionCommandFromText(textForInference);
				if (inferred) {
					conditionCommand = inferred;
					conditionSource = "inferred";
				} else {
					conditionCommand = "echo true";
					conditionSource = "default";
				}
			}

			const maxIterations = parseLoopNumber(
				params.maxIterations === undefined ? null : String(params.maxIterations),
				DEFAULT_LOOP_MAX_ITERATIONS,
			);
			if (maxIterations === null || maxIterations <= 0) {
				return {
					content: [{ type: "text", text: "maxIterations must be a positive number." }],
					details: buildDetails({
						stopReason: "invalid-params",
						conditionCommand,
						conditionSource,
						prompt: promptInfo,
					}),
					isError: true,
				};
			}

			const sleepMs = parseLoopNumber(
				params.sleepMs === undefined ? null : String(params.sleepMs),
				DEFAULT_LOOP_SLEEP_MS,
				true,
			);
			if (sleepMs === null || sleepMs < 0) {
				return {
					content: [{ type: "text", text: "sleepMs must be zero or a positive number." }],
					details: buildDetails({
						stopReason: "invalid-params",
						conditionCommand,
						conditionSource,
						maxIterations,
						prompt: promptInfo,
					}),
					isError: true,
				};
			}

			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const approved = confirmProjectAgents ? await confirmProjectAgentsOnce(loopParams, ctx) : true;
			if (!approved) {
				return {
					content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
					details: buildDetails({
						stopReason: "canceled",
						conditionCommand,
						conditionSource,
						maxIterations,
						sleepMs,
						prompt: promptInfo,
					}),
					isError: true,
				};
			}
			loopParams.confirmProjectAgents = false;

			const runAbortController = new AbortController();
			const mergedSignal = mergeAbortSignals(signal, runAbortController.signal);
			const baseLoopParams = cloneLoopParams(loopParams);

			loopControl.status = "running";
			loopControl.runId = crypto.randomUUID().slice(0, 8);
			loopControl.iterations = 0;
			loopControl.steering = [];
			loopControl.steeringOnce = [];
			loopControl.followUps = [];
			loopControl.steeringSent = [];
			loopControl.followUpsSent = [];
			loopControl.paused = false;
			loopControl.abortController = runAbortController;
			loopControl.lastDetails = null;

			if (ctx.hasUI) {
				ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
			}

			const iterations: LoopIterationResult[] = [];
			let stopReason = "running";
			let errorMessage = "";
			let lastCondition = { stdout: "", stderr: "", exitCode: 0 };

			const buildLoopDetails = (currentIterations: LoopIterationResult[]): RalphLoopDetails => {
				const details: RalphLoopDetails = {
					iterations: [...currentIterations],
					stopReason,
					conditionCommand,
					conditionSource,
					maxIterations,
					sleepMs,
					lastCondition,
					prompt: promptInfo,
					steering: [...loopControl.steering, ...loopControl.steeringOnce],
					followUps: [...loopControl.followUps],
					steeringSent: [...loopControl.steeringSent],
					followUpsSent: [...loopControl.followUpsSent],
					status: loopControl.status,
				};
				loopControl.iterations = currentIterations.length;
				loopControl.lastDetails = details;
				return details;
			};

			const emitUpdate = () => {
				const details = buildLoopDetails(iterations);
				if (ctx.hasUI) {
					ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
				}
				if (!onUpdate) return;
				onUpdate({
					content: [
						{
							type: "text",
							text: `ralph-loop: ${iterations.length}/${maxIterations} iterations complete`,
						},
					],
					details,
				});
			};

			for (let i = 0; i < maxIterations; i++) {
				if (mergedSignal?.aborted) {
					stopReason = "aborted";
					break;
				}

				if (mergedSignal?.aborted) {
					stopReason = "aborted";
					break;
				}

				const condition = await checkLoopCondition(pi, conditionCommand, ctx.cwd, mergedSignal);
				lastCondition = { stdout: condition.stdout, stderr: condition.stderr, exitCode: condition.exitCode };
				if (!condition.shouldContinue) {
					stopReason = "condition-false";
					break;
				}

				const iterationIndex = i + 1;
				const iterationUpdate: OnUpdateCallback | undefined = onUpdate
					? (partial) => {
						if (!partial.details) return;
						const partialOutput = extractTextFromContent(partial.content);
						const streamingIterations = [
							...iterations,
							{
								index: iterationIndex,
								details: partial.details,
								output: partialOutput || "(running...)",
								isError: partial.isError,
							},
						];
						const details = buildLoopDetails(streamingIterations);
						if (ctx.hasUI) {
							ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
						}
						onUpdate({
							content: partial.content ?? [
								{ type: "text", text: `ralph-loop iteration ${iterationIndex} running...` },
							],
							details,
						});
					}
					: undefined;

				let runResult: LoopExecutionResult | null = null;
				const steeringOnceCount = loopControl.steeringOnce.length;
				const steeringText = formatSteeringText([...loopControl.steering, ...loopControl.steeringOnce]);
				const iterationParams = applySteeringToParams(baseLoopParams, steeringText);
				const queuedFollowUps = loopControl.followUps;
				if (queuedFollowUps.length > 0) {
					loopControl.followUps = [];
					loopControl.followUpsSent.push(...queuedFollowUps);
				}
				try {
					runResult = await executeSubagentOnce(
						iterationParams,
						ctx,
						mergedSignal,
						iterationUpdate,
						registerActiveRun,
						queuedFollowUps,
					);
				} catch (error: any) {
					stopReason = mergedSignal?.aborted ? "aborted" : "error";
					errorMessage = error?.message || String(error);
					break;
				}
				loopControl.steeringOnce = loopControl.steeringOnce.slice(steeringOnceCount);
				loopControl.steeringSent = [];
				loopControl.followUpsSent = [];
				if (loopControl.paused && activeRuns.size === 0) {
					clearPausedState(loopControl);
				}

				iterations.push({
					index: iterationIndex,
					details: runResult.details,
					output: runResult.output,
					isError: runResult.isError,
				});
				emitUpdate();

				if (runResult.isError) {
					stopReason = "error";
					errorMessage = runResult.output;
					break;
				}

				if (sleepMs > 0 && i < maxIterations - 1) {
					await sleep(sleepMs, mergedSignal);
				}
			}

			if (stopReason === "running") {
				stopReason = "max-iterations";
			}

			const lastOutput = iterations.length > 0 ? iterations[iterations.length - 1].output : "";
			const summaryLines = [
				`ralph-loop finished after ${iterations.length} iteration${iterations.length === 1 ? "" : "s"}.`,
				`Stop reason: ${stopReason}.`,
				`Condition: ${conditionCommand} (${conditionSource}).`,
				`Max iterations: ${maxIterations}.`,
				`Sleep: ${sleepMs}ms.`,
			];

			if (lastCondition.stdout) summaryLines.push(`Condition stdout: ${lastCondition.stdout}`);
			if (lastCondition.stderr) summaryLines.push(`Condition stderr: ${lastCondition.stderr}`);
			if (lastCondition.exitCode !== 0) summaryLines.push(`Condition exit code: ${lastCondition.exitCode}`);
			if (errorMessage && errorMessage !== lastOutput) summaryLines.push(`Error: ${errorMessage}`);
			if (lastOutput) summaryLines.push(`Last output:\n${lastOutput}`);

			loopControl.status = "idle";
			loopControl.abortController = null;
			loopControl.paused = false;
			loopControl.steering = [];
			loopControl.steeringOnce = [];
			loopControl.followUps = [];
			loopControl.steeringSent = [];
			loopControl.followUpsSent = [];
			if (ctx.hasUI) {
				ctx.ui.setStatus("ralph-loop", undefined);
			}

			const finalDetails = buildLoopDetails(iterations);
			const exportText = formatLoopEntriesText(finalDetails);
			const summaryText = exportText
				? `${summaryLines.join("\n\n")}\n\nDetails:\n${exportText}`
				: summaryLines.join("\n\n");
			const isError = stopReason === "error" || stopReason === "aborted";
			return {
				content: [{ type: "text", text: summaryText }],
				details: finalDetails,
				isError,
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			const hasChain = Array.isArray(args.chain) && args.chain.length > 0;
			const hasTasks = Array.isArray(args.tasks) && args.tasks.length > 0;
			const hasSingle = Boolean(args.agent || args.task);
			const mode = hasChain
				? `chain (${args.chain.length} steps)`
				: hasTasks
					? `parallel (${args.tasks.length} tasks)`
					: hasSingle
						? `single ${args.agent || "(auto)"}`
						: "auto";
			const condition = args.conditionCommand ? `cond: ${args.conditionCommand}` : "cond: (auto)";
			const maxIterations = args.maxIterations ?? DEFAULT_LOOP_MAX_ITERATIONS;
			const sleepMs = args.sleepMs ?? DEFAULT_LOOP_SLEEP_MS;
			const promptInfo = buildLoopPromptInfo(args);
			let text =
				theme.fg("toolTitle", theme.bold("ralph_loop ")) +
				theme.fg("accent", mode) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", condition)}`;
			if (promptInfo.items.length > 0) {
				const preview = formatLoopPromptItem(promptInfo.items[0], 40);
				const more = promptInfo.items.length > 1 ? ` +${promptInfo.items.length - 1} more` : "";
				text += `\n  ${theme.fg("dim", `prompt: ${preview}${more}`)}`;
			}
			text += `\n  ${theme.fg("dim", `max:${maxIterations} sleep:${sleepMs}ms`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as RalphLoopDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const iterations = details.iterations || [];
			const isError = details.stopReason === "error" || details.stopReason === "aborted";
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const header =
				icon +
				" " +
				theme.fg("toolTitle", theme.bold("ralph_loop ")) +
				theme.fg("accent", `${iterations.length} iteration${iterations.length === 1 ? "" : "s"}`);

			const wrapper = new Container();
			const mainBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
			const container = new Container();

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Spacer(1));
			container.addChild(new Text(header, 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)));

			const entriesComponent = renderLoopEntries(buildLoopEntries(details), theme, undefined, process.cwd(), expanded);
			container.addChild(entriesComponent);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			mainBox.addChild(container);
			wrapper.addChild(mainBox);
			return wrapper;
		},
	});
}
