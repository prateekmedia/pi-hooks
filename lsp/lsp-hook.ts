/**
 * LSP Hook for pi-coding-agent
 * 
 * Provides Language Server Protocol integration for diagnostics feedback.
 * After file writes/edits, automatically fetches LSP diagnostics and appends
 * them to the tool result so the agent can fix errors.
 */

import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";
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

const DIAGNOSTICS_TIMEOUT_MS = 5000;
const INIT_TIMEOUT_MS = 30000;

// ============================================================================
// Types
// ============================================================================

interface LSPServerConfig {
  id: string;
  extensions: string[];
  findRoot: (file: string, cwd: string) => Promise<string | undefined>;
  spawn: (root: string) => Promise<LSPHandle | undefined>;
}

interface LSPHandle {
  process: ChildProcessWithoutNullStreams;
  initializationOptions?: Record<string, unknown>;
}

interface LSPClient {
  serverId: string;
  root: string;
  connection: MessageConnection;
  process: ChildProcessWithoutNullStreams;
  diagnostics: Map<string, Diagnostic[]>;
  openFiles: Map<string, number>;
  diagnosticsListeners: Map<string, Array<() => void>>;
}

// ============================================================================
// Language IDs
// ============================================================================

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
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

// ============================================================================
// Utilities
// ============================================================================

function which(cmd: string): string | undefined {
  const envPath = process.env.PATH || "";
  const paths = envPath.split(path.delimiter);
  const ext = process.platform === "win32" ? ".exe" : "";

  for (const p of paths) {
    const full = path.join(p, cmd + ext);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch { /* ignore */ }
  }

  const commonPaths = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(process.env.HOME || "", ".pub-cache/bin"),
    path.join(process.env.HOME || "", "fvm/default/bin"),
    path.join(process.env.HOME || "", "go/bin"),
    path.join(process.env.HOME || "", ".cargo/bin"),
  ];

  for (const p of commonPaths) {
    const full = path.join(p, cmd + ext);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch { /* ignore */ }
  }

  return undefined;
}

async function findNearestFile(startDir: string, targets: string[], stopDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);

  while (current.length >= stop.length) {
    for (const target of targets) {
      const candidate = path.join(current, target);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* ignore */ }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function findRoot(file: string, cwd: string, markers: string[]): Promise<string | undefined> {
  const found = await findNearestFile(path.dirname(file), markers, cwd);
  return found ? path.dirname(found) : cwd;
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms);
    promise.then((r) => { clearTimeout(timer); resolve(r); }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ============================================================================
// Diagnostic Formatting
// ============================================================================

function prettyDiagnostic(d: Diagnostic): string {
  const severityMap: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" };
  const severity = severityMap[d.severity || 1];
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  return `${severity} [${line}:${col}] ${d.message}`;
}

// ============================================================================
// LSP Server Configurations
// ============================================================================

const LSP_SERVERS: LSPServerConfig[] = [
  // Dart/Flutter
  {
    id: "dart",
    extensions: [".dart"],
    findRoot: async (file, cwd) => findRoot(file, cwd, ["pubspec.yaml", "analysis_options.yaml"]),
    spawn: async (root) => {
      let dartBin = which("dart");
      
      // Check for Flutter project
      const pubspecPath = path.join(root, "pubspec.yaml");
      if (fs.existsSync(pubspecPath)) {
        try {
          const content = fs.readFileSync(pubspecPath, "utf-8");
          if (content.includes("flutter:") || content.includes("sdk: flutter")) {
            const flutterBin = which("flutter");
            if (flutterBin) {
              const flutterDir = path.dirname(fs.realpathSync(flutterBin));
              for (const p of [
                path.join(flutterDir, "cache", "dart-sdk", "bin", "dart"),
                path.join(flutterDir, "..", "cache", "dart-sdk", "bin", "dart"),
              ]) {
                if (fs.existsSync(p)) { dartBin = p; break; }
              }
            }
          }
        } catch { /* ignore */ }
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

  // TypeScript/JavaScript
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    findRoot: async (file, cwd) => {
      const denoConfig = await findNearestFile(path.dirname(file), ["deno.json", "deno.jsonc"], cwd);
      if (denoConfig) return undefined;
      return findRoot(file, cwd, ["package.json", "tsconfig.json", "jsconfig.json"]);
    },
    spawn: async (root) => {
      const localBin = path.join(root, "node_modules", ".bin", "typescript-language-server");
      const cmd = fs.existsSync(localBin) ? localBin : which("typescript-language-server");
      if (!cmd) return undefined;
      return { process: spawn(cmd, ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
    },
  },

  // Vue
  {
    id: "vue",
    extensions: [".vue"],
    findRoot: async (file, cwd) => findRoot(file, cwd, ["package.json", "vite.config.ts", "vite.config.js"]),
    spawn: async (root) => {
      const cmd = which("vue-language-server");
      if (!cmd) { return undefined; }
      return { process: spawn(cmd, ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
    },
  },

  // Svelte
  {
    id: "svelte",
    extensions: [".svelte"],
    findRoot: async (file, cwd) => findRoot(file, cwd, ["package.json", "svelte.config.js"]),
    spawn: async (root) => {
      const cmd = which("svelteserver");
      if (!cmd) { return undefined; }
      return { process: spawn(cmd, ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
    },
  },

  // Python
  {
    id: "pyright",
    extensions: [".py", ".pyi"],
    findRoot: async (file, cwd) => findRoot(file, cwd, ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"]),
    spawn: async (root) => {
      const cmd = which("pyright-langserver");
      if (!cmd) { return undefined; }
      return { process: spawn(cmd, ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
    },
  },

  // Go
  {
    id: "gopls",
    extensions: [".go"],
    findRoot: async (file, cwd) => {
      const workRoot = await findRoot(file, cwd, ["go.work"]);
      if (workRoot !== cwd) return workRoot;
      return findRoot(file, cwd, ["go.mod"]);
    },
    spawn: async (root) => {
      const cmd = which("gopls");
      if (!cmd) { return undefined; }
      return { process: spawn(cmd, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
    },
  },

  // Rust
  {
    id: "rust-analyzer",
    extensions: [".rs"],
    findRoot: async (file, cwd) => findRoot(file, cwd, ["Cargo.toml"]),
    spawn: async (root) => {
      const cmd = which("rust-analyzer");
      if (!cmd) { return undefined; }
      return { process: spawn(cmd, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
    },
  },
];

// ============================================================================
// LSP Manager
// ============================================================================

class LSPManager {
  private clients: Map<string, LSPClient> = new Map();
  private spawning: Map<string, Promise<LSPClient | undefined>> = new Map();
  private broken: Set<string> = new Set();
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private getClientKey(serverId: string, root: string): string {
    return `${serverId}:${root}`;
  }

  private async initializeClient(config: LSPServerConfig, root: string): Promise<LSPClient | undefined> {
    const key = this.getClientKey(config.id, root);

    try {
      const handle = await config.spawn(root);
      if (!handle) {
        this.broken.add(key);
        return undefined;
      }

      const connection = createMessageConnection(
        new StreamMessageReader(handle.process.stdout!),
        new StreamMessageWriter(handle.process.stdin!)
      );

      const client: LSPClient = {
        serverId: config.id,
        root,
        connection,
        process: handle.process,
        diagnostics: new Map(),
        openFiles: new Map(),
        diagnosticsListeners: new Map(),
      };

      connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
        const filePath = decodeURIComponent(new URL(params.uri).pathname);
        client.diagnostics.set(filePath, params.diagnostics);

        const listeners = client.diagnosticsListeners.get(filePath);
        if (listeners) {
          for (const listener of listeners) listener();
          client.diagnosticsListeners.delete(filePath);
        }
      });

      connection.onRequest("workspace/configuration", () => [handle.initializationOptions ?? {}]);
      connection.onRequest("window/workDoneProgress/create", () => null);
      connection.onRequest("client/registerCapability", () => {});
      connection.onRequest("client/unregisterCapability", () => {});
      connection.onRequest("workspace/workspaceFolders", () => [{ name: "workspace", uri: `file://${root}` }]);

      handle.process.stderr?.on("data", (data) => {
      });

      handle.process.on("exit", (code) => {
        this.clients.delete(key);
      });

      handle.process.on("error", (err) => {
        this.clients.delete(key);
        this.broken.add(key);
      });

      connection.listen();

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
              synchronization: { didOpen: true, didChange: true, didClose: true },
              publishDiagnostics: { versionSupport: true },
            },
          },
        }),
        INIT_TIMEOUT_MS,
        `${config.id} initialize`
      );

      await connection.sendNotification("initialized", {});

      if (handle.initializationOptions) {
        await connection.sendNotification("workspace/didChangeConfiguration", {
          settings: handle.initializationOptions,
        });
      }

      return client;
    } catch (err) {
      this.broken.add(key);
      return undefined;
    }
  }

  async getClientsForFile(filePath: string): Promise<LSPClient[]> {
    const ext = path.extname(filePath);
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
    const clients: LSPClient[] = [];

    for (const config of LSP_SERVERS) {
      if (!config.extensions.includes(ext)) continue;

      const root = await config.findRoot(absPath, this.cwd);
      if (!root) continue;

      const key = this.getClientKey(config.id, root);
      if (this.broken.has(key)) continue;

      const existing = this.clients.get(key);
      if (existing) {
        clients.push(existing);
        continue;
      }

      let inflightPromise = this.spawning.get(key);
      if (!inflightPromise) {
        inflightPromise = this.initializeClient(config, root);
        this.spawning.set(key, inflightPromise);
        inflightPromise.finally(() => this.spawning.delete(key));
      }

      const client = await inflightPromise;
      if (client) {
        this.clients.set(key, client);
        clients.push(client);
      }
    }

    return clients;
  }

  async touchFile(filePath: string, waitForDiagnostics: boolean = true): Promise<void> {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);

    const clients = await this.getClientsForFile(absPath);
    if (clients.length === 0) {
      return;
    }

    const uri = `file://${absPath}`;
    const ext = path.extname(filePath);
    const languageId = LANGUAGE_IDS[ext] || "plaintext";

    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch (err) {
      return;
    }

    const diagnosticsPromises: Promise<void>[] = [];

    for (const client of clients) {
      const version = client.openFiles.get(absPath);

      let diagnosticsPromise: Promise<void> | undefined;
      if (waitForDiagnostics) {
        diagnosticsPromise = new Promise<void>((resolve) => {
          const timeoutId = setTimeout(() => {
            resolve();
          }, DIAGNOSTICS_TIMEOUT_MS);

          const listeners = client.diagnosticsListeners.get(absPath) || [];
          listeners.push(() => {
            clearTimeout(timeoutId);
            resolve();
          });
          client.diagnosticsListeners.set(absPath, listeners);
        });
        diagnosticsPromises.push(diagnosticsPromise);
      }

      try {
        if (version !== undefined) {
          const newVersion = version + 1;
          client.openFiles.set(absPath, newVersion);
          client.diagnostics.delete(absPath);
          await client.connection.sendNotification("textDocument/didChange", {
            textDocument: { uri, version: newVersion },
            contentChanges: [{ text: content }],
          });
        } else {
          client.openFiles.set(absPath, 0);
          client.diagnostics.delete(absPath);
          await client.connection.sendNotification("textDocument/didOpen", {
            textDocument: { uri, languageId, version: 0, text: content },
          });
        }
      } catch (err) {
      }
    }

    if (waitForDiagnostics && diagnosticsPromises.length > 0) {
      await Promise.all(diagnosticsPromises);
    }
  }

  /** Get all diagnostics from all clients */
  getAllDiagnostics(): Record<string, Diagnostic[]> {
    const results: Record<string, Diagnostic[]> = {};
    for (const client of this.clients.values()) {
      for (const [filePath, diagnostics] of client.diagnostics) {
        const arr = results[filePath] || [];
        arr.push(...diagnostics);
        results[filePath] = arr;
      }
    }
    return results;
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.connection.sendRequest("shutdown");
        await client.connection.sendNotification("exit");
        client.connection.end();
        client.process.kill();
      } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}

// ============================================================================
// Hook Export
// ============================================================================

export default function (pi: HookAPI) {
  let lspManager: LSPManager | null = null;

  pi.on("session_start", async (_event, ctx) => {
    lspManager = new LSPManager(ctx.cwd);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!lspManager) return;

    const isWrite = event.toolName === "write";
    const isEdit = event.toolName === "edit";
    if (!isWrite && !isEdit) return;

    const filePath = event.input.path as string;
    if (!filePath) return;

    const ext = path.extname(filePath);
    const supported = LSP_SERVERS.some((s) => s.extensions.includes(ext));
    if (!supported) return;


    try {
      await lspManager.touchFile(filePath, true);
      const diagnostics = lspManager.getAllDiagnostics();

      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
      let output = "";

      // Format diagnostics for LLM
      for (const [file, issues] of Object.entries(diagnostics)) {
        if (issues.length === 0) continue;

        if (file === absPath) {
          // For the edited file
          const errors = isEdit 
            ? issues.filter((item) => item.severity === 1)  // Edit: only errors
            : issues;  // Write: all diagnostics
          
          if (errors.length > 0) {
            const relativePath = path.relative(ctx.cwd, file);
            const errorCount = errors.filter(e => e.severity === 1).length;
            const warnCount = errors.filter(e => e.severity === 2).length;
            
            // Build notification - show full messages, limit count
            const MAX_DISPLAY = 5;
            const displayErrors = errors.slice(0, MAX_DISPLAY);
            const errorLines = displayErrors.map(e => {
              const line = e.range.start.line + 1;
              const sev = e.severity === 1 ? "ERROR" : "WARN";
              const msg = e.message.split('\n')[0]; // First line only
              return `${sev}[${line}] ${msg}`;
            });
            
            let notification = `📋 ${relativePath}\n${errorLines.join('\n')}`;
            if (errors.length > MAX_DISPLAY) {
              notification += `\n... +${errors.length - MAX_DISPLAY} more`;
            }
            
            ctx.ui.notify(notification, errorCount > 0 ? "error" : "warning");
            
            // Full output for LLM
            output += `\nThis file has errors, please fix\n<file_diagnostics>\n${errors.map(prettyDiagnostic).join("\n")}\n</file_diagnostics>\n`;
          }
        } else if (isWrite) {
          // Project diagnostics only for write
          output += `\n<project_diagnostics>\n${file}\n${issues.map(prettyDiagnostic).join("\n")}\n</project_diagnostics>\n`;
        }
      }

      if (output) {
        return { result: event.result + output };
      }
    } catch {
      // Ignore LSP errors silently
    }

    return undefined;
  });
}
