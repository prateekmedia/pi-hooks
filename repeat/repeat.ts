/// <reference path="./types.d.ts" />

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, createEditTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Spacer, Text, getEditorKeybindings, truncateToWidth, type SelectItem } from "@mariozechner/pi-tui";

type RepeatToolName = "bash" | "edit" | "write";

interface RepeatToolCall {
	toolName: RepeatToolName;
	args: Record<string, any>;
	toolCallId: string;
	timestamp: string;
	resultDetails?: any;
	resultIsError?: boolean;
}

function extractText(content: any): string {
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

function truncatePreview(text: string, max: number): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	if (cleaned.length <= max) return cleaned;
	return `${cleaned.slice(0, Math.max(0, max - 3))}...`;
}

function getExternalEditor(): string | null {
	const editor = process.env.VISUAL || process.env.EDITOR;
	return editor && editor.trim() ? editor.trim() : null;
}

function splitCommand(command: string): string[] {
	const trimmed = command.trim();
	if (!trimmed) return [];
	const parts: string[] = [];
	let current = "";
	let quote: "\"" | "'" | null = null;

	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) parts.push(current);
	return parts.length > 0 ? parts : command.split(" ");
}

function buildEditorInvocation(editorCommand: string, filePath: string, line?: number): { command: string; args: string[] } {
	const parts = splitCommand(editorCommand);
	const command = parts[0] || editorCommand;
	const args = parts.slice(1);
	const base = path.basename(command).toLowerCase();
	const terminalEditors = ["vim", "nvim", "vi", "nano", "emacs", "emacsclient", "less", "more"];

	if (line && line > 0) {
		if (terminalEditors.includes(base)) {
			return { command, args: [...args, `+${line}`, filePath] };
		}
		const colonTarget = `${filePath}:${line}`;
		if (base === "open") {
			return { command, args: [...args, "--args", colonTarget] };
		}
		return { command, args: [...args, colonTarget] };
	}

	return { command, args: [...args, filePath] };
}

async function openExternalEditor(
	ctx: any,
	filePath: string,
	line?: number,
): Promise<boolean> {
	const editorCommand = getExternalEditor();
	if (!editorCommand) return false;

	const runEditor = (tui?: any) => {
		const { command, args } = buildEditorInvocation(editorCommand, filePath, line);
		let ok = false;
		try {
			if (tui) tui.stop();
			const result = spawnSync(command, args, { stdio: "inherit" });
			ok = result.status === 0;
		} catch {
			ok = false;
		} finally {
			if (tui) {
				tui.start();
				tui.requestRender(true);
			}
		}
		return ok;
	};

	if (!ctx?.ui?.custom) {
		return runEditor();
	}

	return new Promise<boolean>((resolve) => {
		void ctx.ui.custom((tui, theme, _kb, done) => {
			const text = new Text(theme.fg("accent", "Opening external editor..."), 1, 1);
			setTimeout(() => {
				const ok = runEditor(tui);
				done(ok);
			}, 0);
			return text;
		}).then((result: boolean) => resolve(result));
	});

}


function resolvePath(cwd: string, targetPath: string): string {
	if (path.isAbsolute(targetPath)) return targetPath;
	return path.join(cwd, targetPath);
}

function applyEditOnce(content: string, oldText: string, newText: string): { content: string } | { error: string } {
	if (!oldText) return { error: "oldText is empty" };
	const index = content.indexOf(oldText);
	if (index === -1) return { error: "oldText not found" };
	const nextIndex = content.indexOf(oldText, index + oldText.length);
	if (nextIndex !== -1) return { error: "oldText is not unique" };
	const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
	return { content: updated };
}

async function editContentInExternalEditor(
	ctx: any,
	initialContent: string,
): Promise<{ content: string; saved: boolean } | null> {
	const editorCommand = getExternalEditor();
	if (!editorCommand) return null;

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repeat-"));
	const tmpFile = path.join(tmpDir, "repeat-write.txt");
	fs.writeFileSync(tmpFile, initialContent, "utf-8");
	let initialMtime = 0;
	try {
		initialMtime = fs.statSync(tmpFile).mtimeMs;
	} catch {
		initialMtime = 0;
	}

	try {
		const ok = await openExternalEditor(ctx, tmpFile);
		if (!ok) return null;
		let saved = false;
		try {
			saved = fs.statSync(tmpFile).mtimeMs !== initialMtime;
		} catch {
			saved = false;
		}
		return { content: fs.readFileSync(tmpFile, "utf-8"), saved };
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
}


function collectRepeatCalls(entries: any[]): RepeatToolCall[] {
	const toolResults = new Map<string, { details?: any; isError?: boolean }>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "toolResult" && message.toolCallId) {
			toolResults.set(message.toolCallId, { details: message.details, isError: message.isError });
		}
	}

	const calls: RepeatToolCall[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type !== "toolCall") continue;
			const name = part.name as RepeatToolName;
			if (name !== "bash" && name !== "edit" && name !== "write") continue;
			const result = toolResults.get(part.id);
			calls.push({
				toolName: name,
				args: part.arguments ?? {},
				toolCallId: part.id,
				timestamp: entry.timestamp,
				resultDetails: result?.details,
				resultIsError: result?.isError,
			});
		}
	}

	return calls;
}

function getRepeatLabel(entry: RepeatToolCall): { label: string; description?: string } {
	if (entry.toolName === "bash") {
		const command = String(entry.args?.command ?? "");
		return {
			label: `bash: ${truncatePreview(command || "(empty)", 60)}`,
			description: entry.args?.timeout ? `timeout: ${entry.args.timeout}s` : undefined,
		};
	}
	if (entry.toolName === "edit") {
		const targetPath = String(entry.args?.path ?? "");
		const details = entry.resultDetails as { firstChangedLine?: number } | undefined;
		const line = details?.firstChangedLine ? `line ${details.firstChangedLine}` : "line ?";
		const preview = truncatePreview(String(entry.args?.oldText ?? ""), 40);
		return {
			label: `edit: ${targetPath || "(unknown)"}`,
			description: preview ? `${line} • ${preview}` : line,
		};
	}
	const targetPath = String(entry.args?.path ?? "");
	const bytes = typeof entry.args?.content === "string" ? entry.args.content.length : 0;
	return {
		label: `write: ${targetPath || "(unknown)"}`,
		description: `${bytes} bytes`,
	};
}

async function showRepeatPicker(ctx: any, items: SelectItem[]): Promise<string | null> {
	return ctx.ui.custom((tui, theme, _kb, done) => {
		let searchQuery = "";

		const buildSelectList = (listItems: SelectItem[]) => {
			const selectList = new SelectList(listItems, Math.min(Math.max(listItems.length, 1), 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			return selectList;
		};

		let selectList = buildSelectList(items);

		const applyFilter = () => {
			const tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
			const filtered = tokens.length === 0
				? items
				: items.filter((item) => {
					const haystack = `${item.label ?? ""} ${item.description ?? ""}`.toLowerCase();
					return tokens.every((token) => haystack.includes(token));
				});
			selectList = buildSelectList(filtered);
		};

		const searchLine = {
			render: (width: number) => {
				const prompt = theme.fg("muted", "Type to search:");
				const queryText = searchQuery ? ` ${theme.fg("accent", searchQuery)}` : "";
				return [truncateToWidth(`  ${prompt}${queryText}`, width)];
			},
			invalidate: () => {},
		};

		const selectListWrapper = {
			render: (width: number) => selectList.render(width),
			invalidate: () => selectList.invalidate(),
		};

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold("Repeat tool call")), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(searchLine);
		container.addChild(new Spacer(1));
		container.addChild(selectListWrapper);

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				const kb = getEditorKeybindings();
				if (kb.matches(data, "selectCancel")) {
					if (searchQuery) {
						searchQuery = "";
						applyFilter();
						tui.requestRender();
						return;
					}
					selectList.handleInput(data);
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "deleteCharBackward")) {
					if (searchQuery.length > 0) {
						searchQuery = searchQuery.slice(0, -1);
						applyFilter();
						tui.requestRender();
						return;
					}
				}

				const hasControlChars = [...data].some((ch) => {
					const code = ch.charCodeAt(0);
					return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
				});
				if (!hasControlChars && data.length > 0) {
					searchQuery += data;
					applyFilter();
					tui.requestRender();
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("repeat", {
		description: "Repeat a previous bash/edit/write tool call",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}

			const branchEntries = ctx.sessionManager.getBranch();
			const calls = collectRepeatCalls(branchEntries).reverse();

			if (calls.length === 0) {
				ctx.ui.notify("No bash/edit/write tool calls in the current branch.", "info");
				return;
			}

			const items: SelectItem[] = calls.map((call, index) => {
				const info = getRepeatLabel(call);
				return {
					value: String(index),
					label: info.label,
					description: info.description,
				};
			});

			const selection = await showRepeatPicker(ctx, items);
			if (selection === null) return;

			const selected = calls[Number(selection)];
			if (!selected) return;

			const externalEditor = getExternalEditor();

			if (selected.toolName === "bash") {
				const command = String(selected.args?.command ?? "");
				if (!command.trim()) {
					ctx.ui.notify("No bash command found to repeat.", "warning");
					return;
				}
				ctx.ui.setEditorText(`!${command}`);
				ctx.ui.notify("Loaded bash command into editor. Edit and press Enter to run.", "info");
				return;
			}

			if (selected.toolName === "write") {
				const targetPath = String(selected.args?.path ?? "");
				const content = String(selected.args?.content ?? "");
				if (!targetPath) {
					ctx.ui.notify("Write call is missing a path.", "error");
					return;
				}

				let mode: "repeat" | "edit" = "repeat";
				if (externalEditor) {
					const choice = await ctx.ui.select("Repeat write:", [
						"Re-write same content",
						"Open in $EDITOR",
					]);
					if (!choice) return;
					mode = choice.startsWith("Open") ? "edit" : "repeat";
				}

				const absolutePath = resolvePath(ctx.cwd, targetPath);

				if (externalEditor) {
					const baseContent = mode === "edit"
						? (() => {
							if (fs.existsSync(absolutePath)) {
								try {
									return fs.readFileSync(absolutePath, "utf-8");
								} catch {
									return content;
								}
							}
							return content;
						})()
						: content;

					const edited = await editContentInExternalEditor(ctx, baseContent);
					if (edited === null) return;
					if (!edited.saved) {
						ctx.ui.notify("No changes saved.", "info");
						return;
					}

					const writeTool = createWriteTool(ctx.cwd);
					try {
						const result = await writeTool.execute("repeat-write", { path: targetPath, content: edited.content }, undefined);
						ctx.ui.notify(extractText(result.content) || "Write completed.", "info");
					} catch (error: any) {
						ctx.ui.notify(`Write failed: ${error?.message || String(error)}`, "error");
					}
					return;
				}

				if (mode === "edit") {
					ctx.ui.notify("$EDITOR not configured; cannot open file for write edit.", "warning");
					return;
				}

				const writeTool = createWriteTool(ctx.cwd);
				try {
					const result = await writeTool.execute("repeat-write", { path: targetPath, content }, undefined);
					ctx.ui.notify(extractText(result.content) || "Write completed.", "info");
				} catch (error: any) {
					ctx.ui.notify(`Write failed: ${error?.message || String(error)}`, "error");
				}
				return;
			}

			if (selected.toolName === "edit") {
				const targetPath = String(selected.args?.path ?? "");
				if (!targetPath) {
					ctx.ui.notify("Edit call is missing a path.", "error");
					return;
				}

				let mode: "repeat" | "open" = "repeat";
				if (externalEditor) {
					const choice = await ctx.ui.select("Repeat edit:", [
						"Repeat the Edit",
						"Open file at changed line",
					]);
					if (!choice) return;
					mode = choice.startsWith("Open") ? "open" : "repeat";
				}

				if (mode === "repeat") {
					const oldText = String(selected.args?.oldText ?? "");
					const newText = String(selected.args?.newText ?? "");
					const absolutePath = resolvePath(ctx.cwd, targetPath);

					if (externalEditor) {
						if (!fs.existsSync(absolutePath)) {
							ctx.ui.notify(`File not found: ${targetPath}`, "error");
							return;
						}
						let originalContent = "";
						try {
							originalContent = fs.readFileSync(absolutePath, "utf-8");
						} catch (error: any) {
							ctx.ui.notify(`Failed to read ${targetPath}: ${error?.message || String(error)}`, "error");
							return;
						}

						const applied = applyEditOnce(originalContent, oldText, newText);
						if ("error" in applied) {
							ctx.ui.notify(`Repeat edit failed: ${applied.error}`, "warning");
							return;
						}

						const edited = await editContentInExternalEditor(ctx, applied.content);
						if (edited === null) return;
						if (!edited.saved) {
							ctx.ui.notify("No changes saved.", "info");
							return;
						}

						const writeTool = createWriteTool(ctx.cwd);
						try {
							const result = await writeTool.execute(
								"repeat-edit",
								{ path: targetPath, content: edited.content },
								undefined,
							);
							ctx.ui.notify(extractText(result.content) || "Edit completed.", "info");
						} catch (error: any) {
							ctx.ui.notify(`Edit failed: ${error?.message || String(error)}`, "error");
						}
						return;
					}

					const editTool = createEditTool(ctx.cwd);
					try {
						const result = await editTool.execute("repeat-edit", { path: targetPath, oldText, newText }, undefined);
						ctx.ui.notify(extractText(result.content) || "Edit completed.", "info");
					} catch (error: any) {
						ctx.ui.notify(`Edit failed: ${error?.message || String(error)}`, "error");
					}
					return;
				}

				if (!externalEditor) {
					ctx.ui.notify("$EDITOR not configured; cannot open file for edit repeat.", "warning");
					return;
				}

				const details = selected.resultDetails as { firstChangedLine?: number } | undefined;
				const line = details?.firstChangedLine ?? 1;
				const absolutePath = resolvePath(ctx.cwd, targetPath);
				if (!fs.existsSync(absolutePath)) {
					ctx.ui.notify(`File not found: ${targetPath}`, "error");
					return;
				}

				const ok = await openExternalEditor(ctx, absolutePath, line);
				if (!ok) {
					ctx.ui.notify("Editor closed without success.", "warning");
				}
				return;
			}
		},
	});
}
