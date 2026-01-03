/**
 * LSP Core - Language Server Protocol client management
 *
 * This module contains:
 * - LSP server configurations for various languages
 * - LSPManager class for spawning and managing language servers
 * - Utilities for finding project roots and binaries
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import {
  type Diagnostic,
  Location,
  type LocationLink,
  type DocumentSymbol,
  type SymbolInformation,
  type Hover,
  type Position,
  type SignatureHelp,
} from "vscode-languageserver-types";

// ============================================================================
// Configuration
// ============================================================================

const INIT_TIMEOUT_MS = 30000;
const MAX_OPEN_FILES_PER_CLIENT = 30;
const FILE_IDLE_TIMEOUT_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_MS = 30_000; // 30 seconds

export const LANGUAGE_IDS: Record<string, string> = {
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

interface OpenFileState {
  version: number;
  lastAccess: number;
}

interface LSPClient {
  connection: MessageConnection;
  process: ChildProcessWithoutNullStreams;
  diagnostics: Map<string, Diagnostic[]>;
  openFiles: Map<string, OpenFileState>;
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
  stopDir: string
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

function findRoot(file: string, cwd: string, markers: string[]): string | undefined {
  const found = findNearestFile(path.dirname(file), markers, cwd);
  return found ? path.dirname(found) : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms);
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function simpleSpawn(
  binary: string,
  args: string[] = ["--stdio"]
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

export const LSP_SERVERS: LSPServerConfig[] = [
  {
    id: "dart",
    extensions: [".dart"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["pubspec.yaml", "analysis_options.yaml"]),
    spawn: async (root) => {
      let dartBin = which("dart");

      const pubspecPath = path.join(root, "pubspec.yaml");
      if (fs.existsSync(pubspecPath)) {
        try {
          const content = fs.readFileSync(pubspecPath, "utf-8");
          if (content.includes("flutter:") || content.includes("sdk: flutter")) {
            const flutterBin = which("flutter");
            if (flutterBin) {
              const flutterDir = path.dirname(fs.realpathSync(flutterBin));
              for (const p of ["cache/dart-sdk/bin/dart", "../cache/dart-sdk/bin/dart"]) {
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
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    findRoot: (file, cwd) => {
      if (findNearestFile(path.dirname(file), ["deno.json", "deno.jsonc"], cwd)) return undefined;
      return findRoot(file, cwd, ["package.json", "tsconfig.json", "jsconfig.json"]);
    },
    spawn: async (root) => {
      const localBin = path.join(root, "node_modules/.bin/typescript-language-server");
      const cmd = fs.existsSync(localBin) ? localBin : which("typescript-language-server");
      if (!cmd) return undefined;
      return {
        process: spawn(cmd, ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }),
      };
    },
  },
  {
    id: "vue",
    extensions: [".vue"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["package.json", "vite.config.ts", "vite.config.js"]),
    spawn: simpleSpawn("vue-language-server"),
  },
  {
    id: "svelte",
    extensions: [".svelte"],
    findRoot: (file, cwd) => findRoot(file, cwd, ["package.json", "svelte.config.js"]),
    spawn: simpleSpawn("svelteserver"),
  },
  {
    id: "pyright",
    extensions: [".py", ".pyi"],
    findRoot: (file, cwd) =>
      findRoot(file, cwd, ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"]),
    spawn: simpleSpawn("pyright-langserver"),
  },
  {
    id: "gopls",
    extensions: [".go"],
    findRoot: (file, cwd) => {
      // First check for go.work (workspace root)
      const workRoot = findRoot(file, cwd, ["go.work"]);
      if (workRoot) return workRoot;
      // Fall back to go.mod
      return findRoot(file, cwd, ["go.mod"]);
    },
    spawn: simpleSpawn("gopls", []),
  },
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

export class LSPManager {
  private clients = new Map<string, LSPClient>();
  private spawning = new Map<string, Promise<LSPClient | undefined>>();
  private broken = new Set<string>();
  private cwd: string;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleFiles();
    }, CLEANUP_INTERVAL_MS);
    // Don't block process exit
    this.cleanupTimer.unref();
  }

  private cleanupIdleFiles(): void {
    const now = Date.now();
    for (const client of this.clients.values()) {
      const toClose: string[] = [];
      for (const [filePath, state] of client.openFiles) {
        if (now - state.lastAccess > FILE_IDLE_TIMEOUT_MS) {
          toClose.push(filePath);
        }
      }
      for (const filePath of toClose) {
        this.closeFile(client, filePath);
      }
    }
  }

  private closeFile(client: LSPClient, absPath: string): void {
    const state = client.openFiles.get(absPath);
    if (!state) return;

    try {
      const uri = pathToFileURL(absPath).href;
      client.connection.sendNotification("textDocument/didClose", {
        textDocument: { uri },
      });
    } catch {}

    client.openFiles.delete(absPath);
    // Keep diagnostics cache - still valid until file changes
  }

  private evictLRUIfNeeded(client: LSPClient): void {
    if (client.openFiles.size <= MAX_OPEN_FILES_PER_CLIENT) return;

    let oldest: { path: string; lastAccess: number } | null = null;
    for (const [filePath, state] of client.openFiles) {
      if (!oldest || state.lastAccess < oldest.lastAccess) {
        oldest = { path: filePath, lastAccess: state.lastAccess };
      }
    }

    if (oldest) {
      this.closeFile(client, oldest.path);
    }
  }

  private clientKey(serverId: string, root: string): string {
    return `${serverId}:${root}`;
  }

  private async initializeClient(
    config: LSPServerConfig,
    root: string
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
        new StreamMessageWriter(handle.process.stdin!)
      );

      // Drain stderr to prevent potential deadlock from buffer fill-up
      if (handle.process.stderr) {
        handle.process.stderr.on("data", () => {
          // Discard stderr data - just drain the buffer
        });
      }

      const client: LSPClient = {
        connection,
        process: handle.process,
        diagnostics: new Map(),
        openFiles: new Map(),
        diagnosticsListeners: new Map(),
      };

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
        }
      );

      connection.onRequest("workspace/configuration", () => [handle.initializationOptions ?? {}]);
      connection.onRequest("window/workDoneProgress/create", () => null);
      connection.onRequest("client/registerCapability", () => {});
      connection.onRequest("client/unregisterCapability", () => {});
      connection.onRequest("workspace/workspaceFolders", () => [
        { name: "workspace", uri: pathToFileURL(root).href },
      ]);

      handle.process.on("exit", () => this.clients.delete(key));
      handle.process.on("error", () => {
        this.clients.delete(key);
        this.broken.add(key);
      });

      connection.listen();

      await withTimeout(
        connection.sendRequest("initialize", {
          rootUri: pathToFileURL(root).href,
          processId: process.pid,
          workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
          initializationOptions: handle.initializationOptions ?? {},
          capabilities: {
            window: { workDoneProgress: true },
            workspace: { configuration: true },
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
    } catch {
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

      const root = config.findRoot(absPath, this.cwd);
      if (!root) continue;

      const key = this.clientKey(config.id, root);
      if (this.broken.has(key)) continue;

      const existing = this.clients.get(key);
      if (existing) {
        clients.push(existing);
        continue;
      }

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

  private resolveFilePath(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
  }

  private getLanguageId(filePath: string): string {
    return LANGUAGE_IDS[path.extname(filePath)] || "plaintext";
  }

  private readFileContent(absPath: string): string | null {
    try {
      return fs.readFileSync(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  private toPosition(line: number, column: number): Position {
    return {
      line: Math.max(0, line - 1),
      character: Math.max(0, column - 1),
    };
  }

  private normalizeLocations(
    result: Location | Location[] | LocationLink[] | null | undefined
  ): Location[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    if (items.length === 0) return [];

    if (Location.is(items[0])) {
      return items as Location[];
    }

    return (items as LocationLink[]).map((link) => ({
      uri: link.targetUri,
      range: link.targetSelectionRange ?? link.targetRange,
    }));
  }

  private normalizeSymbols(
    result: DocumentSymbol[] | SymbolInformation[] | null | undefined
  ): DocumentSymbol[] {
    if (!result || result.length === 0) return [];
    const first = result[0] as DocumentSymbol | SymbolInformation;
    if ("location" in first) {
      return (result as SymbolInformation[]).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        range: symbol.location.range,
        selectionRange: symbol.location.range,
        detail: symbol.containerName,
        tags: symbol.tags,
        deprecated: symbol.deprecated,
        children: [],
      }));
    }
    return result as DocumentSymbol[];
  }

  private async sendDidOpenOrChange(
    clients: LSPClient[],
    absPath: string,
    uri: string,
    languageId: string,
    content: string
  ): Promise<void> {
    const now = Date.now();

    for (const client of clients) {
      const state = client.openFiles.get(absPath);

      try {
        if (state !== undefined) {
          // File already open - send didChange
          const newVersion = state.version + 1;
          client.openFiles.set(absPath, { version: newVersion, lastAccess: now });
          await client.connection.sendNotification("textDocument/didChange", {
            textDocument: { uri, version: newVersion },
            contentChanges: [{ text: content }],
          });
        } else {
          // New file - send didOpen
          client.openFiles.set(absPath, { version: 0, lastAccess: now });
          await client.connection.sendNotification("textDocument/didOpen", {
            textDocument: { uri, languageId, version: 0, text: content },
          });
          // Evict oldest file if over limit
          this.evictLRUIfNeeded(client);
        }
      } catch {}
    }
  }

  private async loadFileForClients(filePath: string): Promise<{
    clients: LSPClient[];
    absPath: string;
    uri: string;
    languageId: string;
    content: string;
  } | null> {
    const absPath = this.resolveFilePath(filePath);
    const clients = await this.getClientsForFile(absPath);
    if (clients.length === 0) return null;

    const content = this.readFileContent(absPath);
    if (content === null) return null;

    return {
      clients,
      absPath,
      uri: pathToFileURL(absPath).href,
      languageId: this.getLanguageId(absPath),
      content,
    };
  }

  async touchFileAndWait(filePath: string, timeoutMs: number): Promise<{ diagnostics: Diagnostic[], receivedResponse: boolean }> {
    const loaded = await this.loadFileForClients(filePath);
    if (!loaded) return { diagnostics: [], receivedResponse: false };

    const { clients, absPath, uri, languageId, content } = loaded;

    // Track if this is a newly opened file (TypeScript sends empty diagnostics first on didOpen)
    const isNewlyOpened = clients.some(client => client.openFiles.get(absPath) === undefined);

    const waitPromises: Array<Promise<{ client: LSPClient; responded: boolean }>> = [];
    for (const client of clients) {
      const promise = new Promise<{ client: LSPClient; responded: boolean }>((resolve) => {
        const timer = setTimeout(() => resolve({ client, responded: false }), timeoutMs);
        let notificationCount = 0;
        const minDelay = isNewlyOpened ? 500 : 0; // Wait 500ms after first notification for new files

        const listeners = client.diagnosticsListeners.get(absPath) || [];
        listeners.push(() => {
          notificationCount++;
          // For newly opened files, wait a bit longer to catch potential second notification
          if (isNewlyOpened && notificationCount === 1) {
            setTimeout(() => {
              clearTimeout(timer);
              resolve({ client, responded: true });
            }, minDelay);
          } else {
            clearTimeout(timer);
            resolve({ client, responded: true });
          }
        });
        client.diagnosticsListeners.set(absPath, listeners);
      });
      waitPromises.push(promise);
    }

    await this.sendDidOpenOrChange(clients, absPath, uri, languageId, content);

    const results = await Promise.all(waitPromises);
    let receivedResponse = results.some(r => r.responded);

    const allDiagnostics: Diagnostic[] = [];
    for (const client of clients) {
      const diags = client.diagnostics.get(absPath);
      if (diags) allDiagnostics.push(...diags);
    }

    if (!receivedResponse) {
      const hasCached = clients.some((client) => client.diagnostics.has(absPath));
      if (hasCached) receivedResponse = true;
    }

    return { diagnostics: allDiagnostics, receivedResponse };
  }

  async getDefinition(filePath: string, line: number, column: number): Promise<Location[]> {
    const loaded = await this.loadFileForClients(filePath);
    if (!loaded) return [];

    const { clients, absPath, uri, languageId, content } = loaded;
    await this.sendDidOpenOrChange(clients, absPath, uri, languageId, content);

    const position = this.toPosition(line, column);

    const results = await Promise.all(
      clients.map(async (client) => {
        try {
          const result = (await client.connection.sendRequest("textDocument/definition", {
            textDocument: { uri },
            position,
          })) as Location | Location[] | LocationLink[] | null;
          return this.normalizeLocations(result);
        } catch {
          return [];
        }
      })
    );

    return results.flat();
  }

  async getReferences(filePath: string, line: number, column: number): Promise<Location[]> {
    const loaded = await this.loadFileForClients(filePath);
    if (!loaded) return [];

    const { clients, absPath, uri, languageId, content } = loaded;
    await this.sendDidOpenOrChange(clients, absPath, uri, languageId, content);

    const position = this.toPosition(line, column);

    const results = await Promise.all(
      clients.map(async (client) => {
        try {
          const result = (await client.connection.sendRequest("textDocument/references", {
            textDocument: { uri },
            position,
            context: { includeDeclaration: true },
          })) as Location[] | Location | LocationLink[] | null;
          return this.normalizeLocations(result);
        } catch {
          return [];
        }
      })
    );

    return results.flat();
  }

  async getHover(filePath: string, line: number, column: number): Promise<Hover | null> {
    const loaded = await this.loadFileForClients(filePath);
    if (!loaded) return null;

    const { clients, absPath, uri, languageId, content } = loaded;
    await this.sendDidOpenOrChange(clients, absPath, uri, languageId, content);

    const position = this.toPosition(line, column);
    const results = await Promise.all(
      clients.map(async (client) => {
        try {
          return (await client.connection.sendRequest("textDocument/hover", {
            textDocument: { uri },
            position,
          })) as Hover | null;
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) return result;
    }
    return null;
  }

  async getSignatureHelp(
    filePath: string,
    line: number,
    column: number
  ): Promise<SignatureHelp | null> {
    const loaded = await this.loadFileForClients(filePath);
    if (!loaded) return null;

    const { clients, absPath, uri, languageId, content } = loaded;
    await this.sendDidOpenOrChange(clients, absPath, uri, languageId, content);

    const position = this.toPosition(line, column);
    const results = await Promise.all(
      clients.map(async (client) => {
        try {
          return (await client.connection.sendRequest("textDocument/signatureHelp", {
            textDocument: { uri },
            position,
          })) as SignatureHelp | null;
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) return result;
    }
    return null;
  }

  async getDocumentSymbols(filePath: string): Promise<DocumentSymbol[]> {
    const loaded = await this.loadFileForClients(filePath);
    if (!loaded) return [];

    const { clients, absPath, uri, languageId, content } = loaded;
    await this.sendDidOpenOrChange(clients, absPath, uri, languageId, content);

    const results = await Promise.all(
      clients.map(async (client) => {
        try {
          return (await client.connection.sendRequest("textDocument/documentSymbol", {
            textDocument: { uri },
          })) as DocumentSymbol[] | SymbolInformation[] | null;
        } catch {
          return null;
        }
      })
    );

    return results.flatMap((result) => this.normalizeSymbols(result));
  }

  async shutdown(): Promise<void> {
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

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
// Diagnostic Formatting
// ============================================================================

export function formatDiagnostic(d: Diagnostic): string {
  const severity = ["", "ERROR", "WARN", "INFO", "HINT"][d.severity || 1];
  return `${severity} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;
}
