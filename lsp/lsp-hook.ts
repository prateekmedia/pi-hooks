/**
 * LSP Hook for pi-coding-agent
 *
 * Provides Language Server Protocol integration for diagnostics feedback.
 * After file writes/edits, automatically fetches LSP diagnostics and appends
 * them to the tool result so the agent can fix errors.
 */

import type { HookAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent/hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import type { Diagnostic } from "vscode-languageserver-types";

// ============================================================================
// Configuration
// ============================================================================

const DIAGNOSTICS_WAIT_MS = 3000;
const INIT_TIMEOUT_MS = 30000;

const LANGUAGE_IDS: Record<string, string> = {
  ".dart": "dart",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
};

// ============================================================================
// Types
// ============================================================================

interface LSPServerConfig {
  id: string;
  extensions: string[];
  findRoot: (file: string, cwd: string) => string | undefined;
  spawn: (root: string) => Promise<LSPHandle | undefined>;
}

interface LSPHandle {
  process: ChildProcessWithoutNullStreams;
  initializationOptions?: Record<string, unknown>;
}

interface LSPClient {
  connection: MessageConnection;
  process: ChildProcessWithoutNullStreams;
  diagnostics: Map<string, Diagnostic[]>;
  openFiles: Map<string, number>;
  diagnosticsListeners: Map<string, Array<() => void>>;
}

// ============================================================================
// Utilities
// ============================================================================

const SEARCH_PATHS = [
  ...(process.env.PATH?.split(path.delimiter) || []),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${process.env.HOME || ""}/.pub-cache/bin`,
  `${process.env.HOME || ""}/fvm/default/bin`,
  `${process.env.HOME || ""}/go/bin`,
  `${process.env.HOME || ""}/.cargo/bin`,
];

function which(cmd: string): string | undefined {
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const dir of SEARCH_PATHS) {
    const full = path.join(dir, cmd + ext);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {}
  }
  return undefined;
}

function findNearestFile(
  startDir: string,
  targets: string[],
  stopDir: string,
): string | undefined {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);

  while (current.length >= stop.length) {
    for (const target of targets) {
      const candidate = path.join(current, target);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function findRoot(
  file: string,
  cwd: string,
  markers: string[],
): string | undefined {
  const found = findNearestFile(path.dirname(file), markers, cwd);
  return found ? path.dirname(found) : cwd;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  name: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatDiagnostic(d: Diagnostic): string {
  const severity = ["", "ERROR", "WARN", "INFO", "HINT"][d.severity || 1];
  return `${severity} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;
}

// Helper to create simple spawn functions
function simpleSpawn(
  binary: string,
  args: string[] = ["--stdio"],
): (root: string) => Promise<LSPHandle | undefined> {
  return async (root) => {
    const cmd = which(binary);
    if (!cmd) return undefined;
    return {
      process: spawn(cmd, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] }),
    };
  };
}

// ============================================================================
// LSP Server Configurations
// ============================================================================

const LSP_SERVERS: LSPServerConfig[] = [
  // Dart/Flutter
  {
    id: "dart",
    extensions: [".dart"],
    findRoot: (file, cwd) =>
      findRoot(file, cwd, ["pubspec.yaml", "analysis_options.yaml"]),
    spawn: async (root) => {
      let dartBin = which("dart");

      // For Flutter projects, prefer Flutter's embedded Dart SDK
      const pubspecPath = path.join(root, "pubspec.yaml");
      if (fs.existsSync(pubspecPath)) {
        try {
          const content = fs.readFileSync(pubspecPath, "utf-8");
          if (
            content.includes("flutter:") ||
            content.includes("sdk: flutter")
          ) {
            const flutterBin = which("flutter");
            if (flutterBin) {
              const flutterDir = path.dirname(fs.realpathSync(flutterBin));
              for (const p of [
                "cache/dart-sdk/bin/dart",
                "../cache/dart-sdk/bin/dart",
              ]) {
                const candidate = path.join(flutterDir, p);
                if (fs.existsSync(candidate)) {
                  dartBin = candidate;
                  break;
                }
              }
            }
          }
        } catch {}
      }

      if (!dartBin) return undefined;
      return {
        process: spawn(dartBin, ["language-server", "--protocol=lsp"], {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      };
    },
  },

  // TypeScript/JavaScript (skip for Deno projects)
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    findRoot: (file, cwd) => {
      // Skip if Deno project (Deno has its own LSP)
      if (findNearestFile(path.dirname(file), ["deno.json", "deno.jsonc"], cwd))
        return undefined;
      return findRoot(file, cwd, [
        "package.json",
        "tsconfig.json",
        "jsconfig.json",
      ]);
    },
    spawn: async (root) => {
      const localBin = path.join(
        root,
        "node_modules/.bin/typescript-language-server",
      );
      const cmd = fs.existsSync(localBin)
        ? localBin
        : which("typescript-language-server");
      if (!cmd) return undefined;
      return {
        process: spawn(cmd, ["--stdio"], {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      };
    },
  },

  // Vue
  {
    id: "vue",
    extensions: [".vue"],
    findRoot: (file, cwd) =>
      findRoot(file, cwd, ["package.json", "vite.config.ts", "vite.config.js"]),
    spawn: simpleSpawn("vue-language-server"),
  },

  // Svelte
  {
    id: "svelte",
    extensions: [".svelte"],
    findRoot: (file, cwd) =>
      findRoot(file, cwd, ["package.json", "svelte.config.js"]),
    spawn: simpleSpawn("svelteserver"),
  },

  // Python
  {
    id: "pyright",
    extensions: [".py", ".pyi"],
    findRoot: (file, cwd) =>
      findRoot(file, cwd, [
        "pyproject.toml",
        "setup.py",
        "requirements.txt",
        "pyrightconfig.json",
      ]),
    spawn: simpleSpawn("pyright-langserver"),
  },

  // Go (check go.work first for workspaces)
  {
    id: "gopls",
    extensions: [".go"],
    findRoot: (file, cwd) => {
      const workRoot = findRoot(file, cwd, ["go.work"]);
      if (workRoot !== cwd) return workRoot;
      return findRoot(file, cwd, ["go.mod"]);
    },
    spawn: simpleSpawn("gopls", []),
  },

  // Rust
  {
    id: "rust-analyzer",
    extensions: [".rs"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["Cargo.toml"]),
    spawn: simpleSpawn("rust-analyzer", []),
  },
];

// ============================================================================
// LSP Manager
// ============================================================================

class LSPManager {
  private clients = new Map<string, LSPClient>();
  private spawning = new Map<string, Promise<LSPClient | undefined>>();
  private broken = new Set<string>();
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private clientKey(serverId: string, root: string): string {
    return `${serverId}:${root}`;
  }

  private async initializeClient(
    config: LSPServerConfig,
    root: string,
  ): Promise<LSPClient | undefined> {
    const key = this.clientKey(config.id, root);

    try {
      const handle = await config.spawn(root);
      if (!handle) {
        this.broken.add(key);
        return undefined;
      }

      const connection = createMessageConnection(
        new StreamMessageReader(handle.process.stdout!),
        new StreamMessageWriter(handle.process.stdin!),
      );

      const client: LSPClient = {
        connection,
        process: handle.process,
        diagnostics: new Map(),
        openFiles: new Map(),
        diagnosticsListeners: new Map(),
      };

      // Handle incoming diagnostics
      connection.onNotification(
        "textDocument/publishDiagnostics",
        (params: { uri: string; diagnostics: Diagnostic[] }) => {
          const filePath = decodeURIComponent(new URL(params.uri).pathname);
          client.diagnostics.set(filePath, params.diagnostics);

          const listeners = client.diagnosticsListeners.get(filePath);
          if (listeners) {
            listeners.forEach((fn) => fn());
            client.diagnosticsListeners.delete(filePath);
          }
        },
      );

      // Handle LSP requests
      connection.onRequest("workspace/configuration", () => [
        handle.initializationOptions ?? {},
      ]);
      connection.onRequest("window/workDoneProgress/create", () => null);
      connection.onRequest("client/registerCapability", () => {});
      connection.onRequest("client/unregisterCapability", () => {});
      connection.onRequest("workspace/workspaceFolders", () => [
        { name: "workspace", uri: `file://${root}` },
      ]);

      // Handle lifecycle
      handle.process.on("exit", () => this.clients.delete(key));
      handle.process.on("error", () => {
        this.clients.delete(key);
        this.broken.add(key);
      });

      connection.listen();

      // Initialize LSP protocol
      await withTimeout(
        connection.sendRequest("initialize", {
          rootUri: `file://${root}`,
          processId: process.pid,
          workspaceFolders: [{ name: "workspace", uri: `file://${root}` }],
          initializationOptions: handle.initializationOptions ?? {},
          capabilities: {
            window: { workDoneProgress: true },
            workspace: { configuration: true, workspaceFolders: true },
            textDocument: {
              synchronization: {
                didOpen: true,
                didChange: true,
                didClose: true,
              },
              publishDiagnostics: { versionSupport: true },
            },
          },
        }),
        INIT_TIMEOUT_MS,
        `${config.id} initialize`,
      );

      await connection.sendNotification("initialized", {});

      if (handle.initializationOptions) {
        await connection.sendNotification("workspace/didChangeConfiguration", {
          settings: handle.initializationOptions,
        });
      }

      return client;
    } catch {
      this.broken.add(key);
      return undefined;
    }
  }

  async getClientsForFile(filePath: string): Promise<LSPClient[]> {
    const ext = path.extname(filePath);
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.cwd, filePath);
    const clients: LSPClient[] = [];

    for (const config of LSP_SERVERS) {
      if (!config.extensions.includes(ext)) continue;

      const root = config.findRoot(absPath, this.cwd);
      if (!root) continue;

      const key = this.clientKey(config.id, root);
      if (this.broken.has(key)) continue;

      // Return existing client
      const existing = this.clients.get(key);
      if (existing) {
        clients.push(existing);
        continue;
      }

      // Deduplicate concurrent spawns
      if (!this.spawning.has(key)) {
        const promise = this.initializeClient(config, root);
        this.spawning.set(key, promise);
        promise.finally(() => this.spawning.delete(key));
      }

      const client = await this.spawning.get(key);
      if (client) {
        this.clients.set(key, client);
        clients.push(client);
      }
    }

    return clients;
  }

  async touchFileAndWait(
    filePath: string,
    timeoutMs: number,
  ): Promise<Diagnostic[]> {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.cwd, filePath);
    const clients = await this.getClientsForFile(absPath);
    if (clients.length === 0) return [];

    const uri = `file://${absPath}`;
    const languageId = LANGUAGE_IDS[path.extname(filePath)] || "plaintext";

    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      return [];
    }

    // Set up listeners BEFORE sending notifications (avoid race condition)
    const waitPromises: Promise<void>[] = [];
    for (const client of clients) {
      client.diagnostics.delete(absPath);

      const promise = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const listeners = client.diagnosticsListeners.get(absPath) || [];
        listeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
        client.diagnosticsListeners.set(absPath, listeners);
      });
      waitPromises.push(promise);
    }

    // Now send notifications
    for (const client of clients) {
      const version = client.openFiles.get(absPath);

      try {
        if (version !== undefined) {
          const newVersion = version + 1;
          client.openFiles.set(absPath, newVersion);
          await client.connection.sendNotification("textDocument/didChange", {
            textDocument: { uri, version: newVersion },
            contentChanges: [{ text: content }],
          });
        } else {
          client.openFiles.set(absPath, 0);
          await client.connection.sendNotification("textDocument/didOpen", {
            textDocument: { uri, languageId, version: 0, text: content },
          });
        }
      } catch {}
    }

    await Promise.all(waitPromises);

    // Collect diagnostics from all clients
    const allDiagnostics: Diagnostic[] = [];
    for (const client of clients) {
      const diags = client.diagnostics.get(absPath);
      if (diags) allDiagnostics.push(...diags);
    }
    return allDiagnostics;
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.connection.sendRequest("shutdown");
        await client.connection.sendNotification("exit");
        client.connection.end();
        client.process.kill();
      } catch {}
    }
    this.clients.clear();
  }
}

// ============================================================================
// Hook Export
// ============================================================================

export default function (pi: HookAPI) {
  let lspManager: LSPManager | null = null;

  pi.on("session", async (event, ctx) => {
    // On clear or switch, shutdown existing LSP manager
    if (event.reason === "clear" || event.reason === "switch") {
      if (lspManager) {
        await lspManager.shutdown();
        lspManager = null;
      }
    }
    
    // Initialize LSP manager on start or switch
    if (event.reason === "start" || event.reason === "switch") {
      lspManager = new LSPManager(ctx.cwd);

      // Pre-warm: trigger LSP initialization for detected project type
      const warmupMap: Record<string, string> = {
        "pubspec.yaml": ".dart",
        "package.json": ".ts",
        "pyproject.toml": ".py",
        "go.mod": ".go",
        "Cargo.toml": ".rs",
      };

      for (const [marker, ext] of Object.entries(warmupMap)) {
        if (fs.existsSync(path.join(ctx.cwd, marker))) {
          // Trigger lazy init without waiting
          lspManager
            .getClientsForFile(path.join(ctx.cwd, `dummy${ext}`))
            .catch(() => {});
          break;
        }
      }
    }
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    if (!lspManager) return;

    const isWrite = event.toolName === "write";
    const isEdit = event.toolName === "edit";
    if (!isWrite && !isEdit) return;

    const filePath = event.input.path as string;
    if (!filePath) return;

    const ext = path.extname(filePath);
    if (!LSP_SERVERS.some((s) => s.extensions.includes(ext))) return;

    try {
      const diagnostics = await lspManager.touchFileAndWait(
        filePath,
        DIAGNOSTICS_WAIT_MS,
      );

      // For edits: only errors (agent is mid-fix). For writes: show all.
      const errors = isEdit
        ? diagnostics.filter((d) => d.severity === 1)
        : diagnostics;
      if (errors.length === 0) return;

      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ctx.cwd, filePath);
      const relativePath = path.relative(ctx.cwd, absPath);
      const errorCount = errors.filter((e) => e.severity === 1).length;

      // Build notification
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

      // Append to result for LLM
      const output = `\nThis file has errors, please fix\n<file_diagnostics>\n${errors.map(formatDiagnostic).join("\n")}\n</file_diagnostics>\n`;
      return { 
        content: [
          ...event.content,
          { type: "text" as const, text: output }
        ] 
      };
    } catch {}

    return undefined;
  });
}
