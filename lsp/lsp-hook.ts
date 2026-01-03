/**
 * LSP Hook utilities - state management and event handlers
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { LSPManager } from "./lsp-core.js";
import { LSP_SERVERS, formatDiagnostic } from "./lsp-core.js";
import { getOrCreateManager, shutdownManager } from "./lsp-shared.js";

// ============================================================================
// Configuration
// ============================================================================

const DIAGNOSTICS_WAIT_MS = 3000;

// ANSI codes
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// ============================================================================
// State
// ============================================================================

export interface LSPState {
  manager: LSPManager | null;
  activeClients: Set<string>;
  statusUpdateFn: ((key: string, text: string | undefined) => void) | null;
}

export function createInitialState(): LSPState {
  return {
    manager: null,
    activeClients: new Set(),
    statusUpdateFn: null,
  };
}

// ============================================================================
// Status Updates
// ============================================================================

function updateLspStatus(state: LSPState): void {
  if (!state.statusUpdateFn) return;
  if (state.activeClients.size === 0) {
    state.statusUpdateFn("lsp", undefined);
  } else {
    const servers = Array.from(state.activeClients).join(", ");
    state.statusUpdateFn("lsp", `${GREEN}LSP${RESET} ${DIM}${servers}${RESET}`);
  }
}

// ============================================================================
// Handlers
// ============================================================================

/** Handle session_start - initialize LSP manager and warm up servers */
export function handleSessionStart(state: LSPState, ctx: any): void {
  state.manager = getOrCreateManager(ctx.cwd);
  state.statusUpdateFn =
    ctx.hasUI && ctx.ui.setStatus ? ctx.ui.setStatus.bind(ctx.ui) : null;

  const warmupMap: Record<string, string> = {
    "pubspec.yaml": ".dart",
    "package.json": ".ts",
    "pyproject.toml": ".py",
    "go.mod": ".go",
    "Cargo.toml": ".rs",
  };

  for (const [marker, ext] of Object.entries(warmupMap)) {
    if (fs.existsSync(path.join(ctx.cwd, marker))) {
      if (state.statusUpdateFn) {
        state.statusUpdateFn("lsp", `${YELLOW}LSP${RESET} ${DIM}Loading...${RESET}`);
      }
      state.manager
        .getClientsForFile(path.join(ctx.cwd, `dummy${ext}`))
        .then((clients) => {
          if (clients.length > 0) {
            const serverConfig = LSP_SERVERS.find((s) => s.extensions.includes(ext));
            if (serverConfig) {
              state.activeClients.add(serverConfig.id);
              updateLspStatus(state);
            }
          } else {
            updateLspStatus(state);
          }
        })
        .catch(() => {
          updateLspStatus(state);
        });
      break;
    }
  }
}

/** Handle session_shutdown - clean up LSP connections */
export async function handleSessionShutdown(state: LSPState): Promise<void> {
  await shutdownManager();
  state.manager = null;
  state.activeClients.clear();
  if (state.statusUpdateFn) {
    state.statusUpdateFn("lsp", undefined);
  }
}

/** Handle tool_result for write/edit - fetch diagnostics and append to result */
export async function handleToolResult(
  state: LSPState,
  toolName: string,
  input: Record<string, unknown>,
  content: Array<{ type: string; text?: string }>,
  ctx: any
): Promise<{ content: Array<{ type: "text"; text: string }> } | undefined> {
  if (!state.manager) return undefined;

  const isWrite = toolName === "write";
  const isEdit = toolName === "edit";
  if (!isWrite && !isEdit) return undefined;

  const filePath = input.path as string;
  if (!filePath) return undefined;

  const ext = path.extname(filePath);
  const serverConfig = LSP_SERVERS.find((s) => s.extensions.includes(ext));
  if (!serverConfig) return undefined;

  // Track active LSP server
  if (!state.activeClients.has(serverConfig.id)) {
    state.activeClients.add(serverConfig.id);
    updateLspStatus(state);
  }

  try {
    const result = await state.manager.touchFileAndWait(filePath, DIAGNOSTICS_WAIT_MS);
    if (!result.receivedResponse) return undefined;

    const diagnostics = result.diagnostics;
    const errors = isEdit ? diagnostics.filter((d) => d.severity === 1) : diagnostics;
    if (errors.length === 0) return undefined;

    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
    const relativePath = path.relative(ctx.cwd, absPath);
    const errorCount = errors.filter((e) => e.severity === 1).length;

    const MAX_DISPLAY = 5;
    const lines = errors.slice(0, MAX_DISPLAY).map((e) => {
      const sev = e.severity === 1 ? "ERROR" : "WARN";
      return `${sev}[${e.range.start.line + 1}] ${e.message.split("\n")[0]}`;
    });

    let notification = `📋 ${relativePath}\n${lines.join("\n")}`;
    if (errors.length > MAX_DISPLAY) {
      notification += `\n... +${errors.length - MAX_DISPLAY} more`;
    }

    if (ctx.hasUI) {
      ctx.ui.notify(notification, errorCount > 0 ? "error" : "warning");
    } else {
      console.error(notification);
    }

    const output = `\nThis file has errors, please fix\n<file_diagnostics>\n${errors.map(formatDiagnostic).join("\n")}\n</file_diagnostics>\n`;
    return {
      content: [...content, { type: "text" as const, text: output }] as Array<{
        type: "text";
        text: string;
      }>,
    };
  } catch {}

  return undefined;
}
