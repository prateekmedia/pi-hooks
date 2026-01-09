/**
 * LSP Hook Extension for pi-coding-agent
 *
 * Provides automatic diagnostics feedback after file writes/edits.
 * After write/edit operations, fetches LSP diagnostics and appends
 * them to the tool result so the agent can fix errors.
 *
 * Usage:
 *   pi --extension ./lsp.ts
 *
 * Or load the directory to get both hook and tool:
 *   pi --extension ./lsp/
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Diagnostic } from "vscode-languageserver-protocol";
import { LSP_SERVERS, formatDiagnostic, getOrCreateManager, shutdownManager } from "./lsp-core.js";

type HookScope = "session" | "global";
type HookMode = "edit_write" | "turn_end" | "disabled";

const DIAGNOSTICS_WAIT_MS = 3000;
const DIAGNOSTICS_PREVIEW_LINES = 10;
const DIM = "\x1b[2m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";
const DEFAULT_HOOK_MODE: HookMode = "edit_write";
const SETTINGS_NAMESPACE = "lsp";
const LSP_CONFIG_ENTRY = "lsp-hook-config";

const WARMUP_MAP: Record<string, string> = {
  "pubspec.yaml": ".dart", "package.json": ".ts", "pyproject.toml": ".py", "go.mod": ".go", "Cargo.toml": ".rs",
};

const MODE_LABELS: Record<HookMode, string> = {
  edit_write: "After each edit/write",
  turn_end: "At agent end",
  disabled: "Disabled",
};

interface HookConfigEntry {
  scope: HookScope;
  hookMode?: HookMode;
}

export default function (pi: ExtensionAPI) {
  let activeClients: Set<string> = new Set();
  let statusUpdateFn: ((key: string, text: string | undefined) => void) | null = null;
  let hookMode: HookMode = DEFAULT_HOOK_MODE;
  let hookScope: HookScope = "global";
  const touchedFiles: Map<string, boolean> = new Map();
  const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");

  function readSettingsFile(filePath: string): Record<string, unknown> {
    try {
      if (!fs.existsSync(filePath)) return {};
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  function getGlobalHookMode(): HookMode | undefined {
    const settings = readSettingsFile(globalSettingsPath);
    const lspSettings = settings[SETTINGS_NAMESPACE];
    const hookValue = (lspSettings as { hookMode?: unknown; hookEnabled?: unknown } | undefined)?.hookMode;
    if (hookValue === "edit_write" || hookValue === "turn_end" || hookValue === "disabled") return hookValue;

    const legacyEnabled = (lspSettings as { hookEnabled?: unknown } | undefined)?.hookEnabled;
    if (typeof legacyEnabled === "boolean") return legacyEnabled ? "edit_write" : "disabled";
    return undefined;
  }

  function setGlobalHookMode(mode: HookMode): boolean {
    try {
      const settings = readSettingsFile(globalSettingsPath);
      const existing = settings[SETTINGS_NAMESPACE];
      const nextNamespace = (existing && typeof existing === "object")
        ? { ...(existing as Record<string, unknown>), hookMode: mode }
        : { hookMode: mode };

      settings[SETTINGS_NAMESPACE] = nextNamespace;
      fs.mkdirSync(path.dirname(globalSettingsPath), { recursive: true });
      fs.writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  function getLastHookEntry(ctx: ExtensionContext): HookConfigEntry | undefined {
    const branchEntries = ctx.sessionManager.getBranch();
    let latest: HookConfigEntry | undefined;

    for (const entry of branchEntries) {
      if (entry.type === "custom" && entry.customType === LSP_CONFIG_ENTRY) {
        latest = entry.data as HookConfigEntry | undefined;
      }
    }

    return latest;
  }

  function restoreHookState(ctx: ExtensionContext): void {
    const entry = getLastHookEntry(ctx);
    if (entry?.scope === "session") {
      if (entry.hookMode) {
        hookMode = entry.hookMode;
        hookScope = "session";
        return;
      }

      const legacyEnabled = (entry as { hookEnabled?: unknown }).hookEnabled;
      if (typeof legacyEnabled === "boolean") {
        hookMode = legacyEnabled ? "edit_write" : "disabled";
        hookScope = "session";
        return;
      }
    }

    const globalSetting = getGlobalHookMode();
    hookMode = globalSetting ?? DEFAULT_HOOK_MODE;
    hookScope = "global";
  }

  function persistHookEntry(entry: HookConfigEntry): void {
    pi.appendEntry<HookConfigEntry>(LSP_CONFIG_ENTRY, entry);
  }

  function labelForMode(mode: HookMode): string {
    return MODE_LABELS[mode];
  }

  function messageContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => (item && typeof item === "object" && "type" in item && (item as any).type === "text")
          ? String((item as any).text ?? "")
          : "")
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  function formatDiagnosticsForDisplay(text: string): string {
    return text
      .replace(/\n?This file has errors, please fix\n/gi, "\n")
      .replace(/<\/?file_diagnostics>\n?/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function updateLspStatus(): void {
    if (!statusUpdateFn) return;

    const clientList = activeClients.size > 0 ? `${DIM}${[...activeClients].join(", ")}${RESET}` : "";

    if (hookMode === "disabled") {
      const text = clientList
        ? `${YELLOW}LSP${RESET} ${DIM}(tool)${RESET}: ${clientList}`
        : `${YELLOW}LSP${RESET} ${DIM}(tool)${RESET}`;
      statusUpdateFn("lsp", text);
      return;
    }

    const text = clientList
      ? `${GREEN}LSP${RESET} ${clientList}`
      : `${GREEN}LSP${RESET}`;
    statusUpdateFn("lsp", text);
  }

  function normalizeFilePath(filePath: string, cwd: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  }

  pi.registerMessageRenderer("lsp-diagnostics", (message, options, theme) => {
    const content = formatDiagnosticsForDisplay(messageContentToText(message.content));
    if (!content) return new Text("", 0, 0);

    const expanded = options.expanded === true;
    const lines = content.split("\n");
    const maxLines = expanded ? lines.length : DIAGNOSTICS_PREVIEW_LINES;
    const display = lines.slice(0, maxLines);
    const remaining = lines.length - display.length;

    const styledLines = display.map((line) => {
      if (line.startsWith("File: ")) return theme.fg("muted", line);
      return theme.fg("toolOutput", line);
    });

    if (!expanded && remaining > 0) {
      styledLines.push(theme.fg("dim", `... (${remaining} more lines)`));
    }

    return new Text(styledLines.join("\n"), 0, 0);
  });

  function getServerConfig(filePath: string) {
    const ext = path.extname(filePath);
    return LSP_SERVERS.find((s) => s.extensions.includes(ext));
  }

  function ensureActiveClientForFile(filePath: string, cwd: string): string | undefined {
    const absPath = normalizeFilePath(filePath, cwd);
    const cfg = getServerConfig(absPath);
    if (!cfg) return undefined;

    if (!activeClients.has(cfg.id)) {
      activeClients.add(cfg.id);
      updateLspStatus();
    }

    return absPath;
  }

  function extractLspFiles(input: Record<string, unknown>): string[] {
    const files: string[] = [];

    if (typeof input.file === "string") files.push(input.file);
    if (Array.isArray(input.files)) {
      for (const item of input.files) {
        if (typeof item === "string") files.push(item);
      }
    }

    return files;
  }

  function buildDiagnosticsOutput(
    filePath: string,
    diagnostics: Diagnostic[],
    cwd: string,
    includeFileHeader: boolean,
  ): { notification: string; errorCount: number; output: string } {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, absPath);
    const errorCount = diagnostics.filter((e) => e.severity === 1).length;

    const MAX = 5;
    const lines = diagnostics.slice(0, MAX).map((e) => {
      const sev = e.severity === 1 ? "ERROR" : "WARN";
      return `${sev}[${e.range.start.line + 1}] ${e.message.split("\n")[0]}`;
    });

    let notification = `📋 ${relativePath}\n${lines.join("\n")}`;
    if (diagnostics.length > MAX) notification += `\n... +${diagnostics.length - MAX} more`;

    const header = includeFileHeader ? `File: ${relativePath}\n` : "";
    const output = `\n${header}This file has errors, please fix\n<file_diagnostics>\n${diagnostics.map(formatDiagnostic).join("\n")}\n</file_diagnostics>\n`;

    return { notification, errorCount, output };
  }

  async function collectDiagnostics(
    filePath: string,
    ctx: ExtensionContext,
    includeWarnings: boolean,
    includeFileHeader: boolean,
    notify = true,
  ): Promise<string | undefined> {
    const manager = getOrCreateManager(ctx.cwd);
    const absPath = ensureActiveClientForFile(filePath, ctx.cwd);
    if (!absPath) return undefined;

    try {
      const result = await manager.touchFileAndWait(absPath, DIAGNOSTICS_WAIT_MS);
      if (!result.receivedResponse) return undefined;

      const diagnostics = includeWarnings
        ? result.diagnostics
        : result.diagnostics.filter((d) => d.severity === 1);
      if (!diagnostics.length) return undefined;

      const report = buildDiagnosticsOutput(filePath, diagnostics, ctx.cwd, includeFileHeader);

      if (notify) {
        if (ctx.hasUI) ctx.ui.notify(report.notification, report.errorCount > 0 ? "error" : "warning");
        else console.error(report.notification);
      }

      return report.output;
    } catch {
      return undefined;
    }
  }

  pi.registerCommand("lsp", {
    description: "LSP settings (auto diagnostics hook)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("LSP settings require UI", "warning");
        return;
      }

      const currentMark = " ✓";
      const modeOptions = ([
        "edit_write",
        "turn_end",
        "disabled",
      ] as HookMode[]).map((mode) => ({
        mode,
        label: mode === hookMode ? `${labelForMode(mode)}${currentMark}` : labelForMode(mode),
      }));

      const modeChoice = await ctx.ui.select(
        "LSP auto diagnostics hook mode:",
        modeOptions.map((option) => option.label),
      );
      if (!modeChoice) return;

      const nextMode = modeOptions.find((option) => option.label === modeChoice)?.mode;
      if (!nextMode) return;

      const scopeOptions = [
        {
          scope: "session" as HookScope,
          label: "Session only",
        },
        {
          scope: "global" as HookScope,
          label: "Global (all sessions)",
        },
      ];

      const scopeChoice = await ctx.ui.select(
        "Apply LSP auto diagnostics hook setting to:",
        scopeOptions.map((option) => option.label),
      );
      if (!scopeChoice) return;

      const scope = scopeOptions.find((option) => option.label === scopeChoice)?.scope;
      if (!scope) return;
      if (scope === "global") {
        const ok = setGlobalHookMode(nextMode);
        if (!ok) {
          ctx.ui.notify("Failed to update global settings", "error");
          return;
        }
      }

      hookMode = nextMode;
      hookScope = scope;
      touchedFiles.clear();
      persistHookEntry({ scope, hookMode: nextMode });
      updateLspStatus();
      ctx.ui.notify(`LSP hook: ${labelForMode(hookMode)} (${hookScope})`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreHookState(ctx);
    statusUpdateFn = ctx.hasUI && ctx.ui.setStatus ? ctx.ui.setStatus.bind(ctx.ui) : null;
    updateLspStatus();

    if (hookMode === "disabled") return;

    const manager = getOrCreateManager(ctx.cwd);

    for (const [marker, ext] of Object.entries(WARMUP_MAP)) {
      if (fs.existsSync(path.join(ctx.cwd, marker))) {
        statusUpdateFn?.("lsp", `${YELLOW}LSP${RESET} ${DIM}Loading...${RESET}`);
        manager.getClientsForFile(path.join(ctx.cwd, `dummy${ext}`))
          .then((clients) => {
            if (clients.length > 0) {
              const cfg = LSP_SERVERS.find((s) => s.extensions.includes(ext));
              if (cfg) { activeClients.add(cfg.id); updateLspStatus(); }
            } else updateLspStatus();
          })
          .catch(() => updateLspStatus());
        break;
      }
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    restoreHookState(ctx);
    updateLspStatus();
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreHookState(ctx);
    updateLspStatus();
  });

  pi.on("session_branch", async (_event, ctx) => {
    restoreHookState(ctx);
    updateLspStatus();
  });

  pi.on("session_shutdown", async () => {
    await shutdownManager();
    activeClients.clear();
    statusUpdateFn?.("lsp", undefined);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "lsp") return;
    const files = extractLspFiles(event.input);
    for (const file of files) {
      ensureActiveClientForFile(file, ctx.cwd);
    }
  });

  pi.on("agent_start", async () => {
    touchedFiles.clear();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (hookMode !== "turn_end") return;
    if (touchedFiles.size === 0) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    const files = Array.from(touchedFiles.entries());
    touchedFiles.clear();

    const outputs: string[] = [];
    for (const [filePath, includeWarnings] of files) {
      const output = await collectDiagnostics(filePath, ctx, includeWarnings, true, false);
      if (output) outputs.push(output);
    }

    if (outputs.length) {
      await pi.sendMessage({
        customType: "lsp-diagnostics",
        content: outputs.join("\n"),
        display: true,
      }, {
        triggerTurn: true,
      });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const filePath = event.input.path as string;
    if (!filePath) return;

    const absPath = ensureActiveClientForFile(filePath, ctx.cwd);
    if (!absPath) return;

    if (hookMode === "disabled") return;

    if (hookMode === "turn_end") {
      const includeWarnings = event.toolName === "write";
      const existing = touchedFiles.get(absPath) ?? false;
      touchedFiles.set(absPath, existing || includeWarnings);
      return;
    }

    const includeWarnings = event.toolName === "write";
    const output = await collectDiagnostics(absPath, ctx, includeWarnings, false);
    if (!output) return;

    return { content: [...event.content, { type: "text" as const, text: output }] as Array<{ type: "text"; text: string }> };
  });
}
