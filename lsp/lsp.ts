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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { LSP_SERVERS, formatDiagnostic, getOrCreateManager, shutdownManager } from "./lsp-core.js";

const DIAGNOSTICS_WAIT_MS = 3000;
const DIM = "\x1b[2m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";

export default function (pi: ExtensionAPI) {
  let activeClients: Set<string> = new Set();
  let statusUpdateFn: ((key: string, text: string | undefined) => void) | null = null;

  function updateLspStatus(): void {
    if (!statusUpdateFn) return;
    if (activeClients.size === 0) {
      statusUpdateFn("lsp", undefined);
    } else {
      statusUpdateFn("lsp", `${GREEN}LSP${RESET} ${DIM}${[...activeClients].join(", ")}${RESET}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const manager = getOrCreateManager(ctx.cwd);
    statusUpdateFn = ctx.hasUI && ctx.ui.setStatus ? ctx.ui.setStatus.bind(ctx.ui) : null;

    const warmupMap: Record<string, string> = {
      "pubspec.yaml": ".dart", "package.json": ".ts", "pyproject.toml": ".py", "go.mod": ".go", "Cargo.toml": ".rs",
    };

    for (const [marker, ext] of Object.entries(warmupMap)) {
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

  pi.on("session_shutdown", async () => {
    await shutdownManager();
    activeClients.clear();
    statusUpdateFn?.("lsp", undefined);
  });

  pi.on("tool_result", async (event, ctx) => {
    const manager = getOrCreateManager(ctx.cwd);
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const filePath = event.input.path as string;
    if (!filePath) return;

    const ext = path.extname(filePath);
    const cfg = LSP_SERVERS.find((s) => s.extensions.includes(ext));
    if (!cfg) return;

    if (!activeClients.has(cfg.id)) {
      activeClients.add(cfg.id);
      updateLspStatus();
    }

    try {
      const result = await manager.touchFileAndWait(filePath, DIAGNOSTICS_WAIT_MS);
      if (!result.receivedResponse) return;

      const errors = event.toolName === "edit"
        ? result.diagnostics.filter((d) => d.severity === 1)
        : result.diagnostics;
      if (!errors.length) return;

      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
      const relativePath = path.relative(ctx.cwd, absPath);
      const errorCount = errors.filter((e) => e.severity === 1).length;

      const MAX = 5;
      const lines = errors.slice(0, MAX).map((e) => {
        const sev = e.severity === 1 ? "ERROR" : "WARN";
        return `${sev}[${e.range.start.line + 1}] ${e.message.split("\n")[0]}`;
      });

      let notification = `📋 ${relativePath}\n${lines.join("\n")}`;
      if (errors.length > MAX) notification += `\n... +${errors.length - MAX} more`;

      if (ctx.hasUI) ctx.ui.notify(notification, errorCount > 0 ? "error" : "warning");
      else console.error(notification);

      const output = `\nThis file has errors, please fix\n<file_diagnostics>\n${errors.map(formatDiagnostic).join("\n")}\n</file_diagnostics>\n`;
      return { content: [...event.content, { type: "text" as const, text: output }] as Array<{ type: "text"; text: string }> };
    } catch { /* ignore errors */ }
  });
}
