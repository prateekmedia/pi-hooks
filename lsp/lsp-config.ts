import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MIN_DIAGNOSTICS_WAIT_MS = 250;
export const MAX_DIAGNOSTICS_WAIT_MS = 60_000;
export const MAX_CONFIG_BYTES = 256 * 1024;

export function defaultGlobalLSPConfigPath(): string {
  return path.join(
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
    "lsp.json",
  );
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const GLOBAL_FIELDS = new Set([
  "command", "args", "extensions", "rootMarkers", "languageIds",
  "initializationOptions", "diagnosticsWaitMs", "disabled",
]);
const PROJECT_FIELDS = new Set(["diagnosticsWaitMs", "disabled"]);

export interface LSPServerDefinition {
  id: string;
  command: string;
  args: string[];
  extensions: string[];
  rootMarkers: string[];
  languageIds: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  diagnosticsWaitMs: number;
  disabled?: boolean;
}

export interface ResolvedLSPServerConfig extends LSPServerDefinition {
  /** Fields changed by global config. Used to retain special builtin launch/root behavior when possible. */
  globalOverrides: ReadonlySet<string>;
  builtin: boolean;
}

export interface LSPConfigWarning {
  path: string;
  message: string;
  server?: string;
}

export interface ResolveLSPConfigOptions {
  cwd: string;
  builtins: readonly LSPServerDefinition[];
  configDirName?: string;
  globalConfigPath?: string;
  projectConfigPath?: string;
}

export interface LSPConfigResult {
  servers: ResolvedLSPServerConfig[];
  warnings: LSPConfigWarning[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownEntries(value: JsonObject): Array<[string, unknown]> {
  return Object.keys(value).map((key) => [key, value[key]]);
}

function safeClone(value: unknown): unknown | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const cloned = safeClone(item);
      if (cloned === undefined) return undefined;
      result.push(cloned);
    }
    return result;
  }
  if (!isObject(value)) return undefined;

  const result = Object.create(null) as JsonObject;
  for (const [key, item] of ownEntries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    const cloned = safeClone(item);
    if (cloned === undefined) return undefined;
    result[key] = cloned;
  }
  return result;
}

function readConfig(filePath: string, warnings: LSPConfigWarning[]): JsonObject | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    if (fs.statSync(filePath).size > MAX_CONFIG_BYTES) {
      throw new Error(`file exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isObject(parsed)) throw new Error("top level must be an object");
    return parsed;
  } catch (error) {
    warnings.push({ path: filePath, message: `Ignored malformed config: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

function serverEntries(config: JsonObject, filePath: string, warnings: LSPConfigWarning[]): Array<[string, JsonObject]> {
  for (const key of Object.keys(config)) {
    if (FORBIDDEN_KEYS.has(key)) {
      warnings.push({ path: filePath, message: `Ignored forbidden key: ${key}` });
    } else if (key !== "servers") {
      warnings.push({ path: filePath, message: `Ignored unknown top-level field: ${key}` });
    }
  }

  const servers = config.servers;
  if (servers === undefined) return [];
  if (!isObject(servers)) {
    warnings.push({ path: filePath, message: 'Ignored "servers": expected an object' });
    return [];
  }

  const result: Array<[string, JsonObject]> = [];
  for (const [id, value] of ownEntries(servers)) {
    if (FORBIDDEN_KEYS.has(id)) {
      warnings.push({ path: filePath, server: id, message: `Ignored forbidden server id: ${id}` });
    } else if (!isObject(value)) {
      warnings.push({ path: filePath, server: id, message: "Ignored server config: expected an object" });
    } else {
      result.push([id, value]);
    }
  }
  return result;
}

function stringArray(value: unknown, nonempty: boolean): string[] | undefined {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) return undefined;
  if (!value.every((item) => typeof item === "string" && item.length > 0)) return undefined;
  return [...value];
}

function extensionArray(value: unknown): string[] | undefined {
  const parsed = stringArray(value, true);
  if (!parsed || parsed.some((extension) => !extension.startsWith("."))) return undefined;
  return parsed.map((extension) => extension.toLowerCase());
}

export function isValidLSPCommand(command: string): boolean {
  return path.isAbsolute(command) || (!command.includes("/") && !command.includes("\\") && command.length > 0);
}

export function clampDiagnosticsWaitMs(value: number): number {
  return Math.max(MIN_DIAGNOSTICS_WAIT_MS, Math.min(MAX_DIAGNOSTICS_WAIT_MS, Math.round(value)));
}

function languageIds(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const result = Object.create(null) as Record<string, string>;
  for (const [extension, id] of ownEntries(value)) {
    if (FORBIDDEN_KEYS.has(extension) || !extension.startsWith(".") || typeof id !== "string" || id.length === 0) return undefined;
    result[extension.toLowerCase()] = id;
  }
  return result;
}

function copyDefinition(definition: LSPServerDefinition, builtin: boolean): ResolvedLSPServerConfig {
  return {
    ...definition,
    args: [...definition.args],
    extensions: [...definition.extensions],
    rootMarkers: [...definition.rootMarkers],
    languageIds: { ...definition.languageIds },
    initializationOptions: definition.initializationOptions
      ? safeClone(definition.initializationOptions) as Record<string, unknown>
      : undefined,
    diagnosticsWaitMs: clampDiagnosticsWaitMs(definition.diagnosticsWaitMs),
    disabled: definition.disabled === true,
    globalOverrides: new Set(),
    builtin,
  };
}

function applyGlobalEntry(
  id: string,
  entry: JsonObject,
  existing: ResolvedLSPServerConfig | undefined,
  filePath: string,
  warnings: LSPConfigWarning[],
): ResolvedLSPServerConfig | undefined {
  for (const key of Object.keys(entry)) {
    if (FORBIDDEN_KEYS.has(key) || !GLOBAL_FIELDS.has(key)) {
      warnings.push({ path: filePath, server: id, message: `Ignored unknown or forbidden field: ${key}` });
    }
  }

  const isNew = !existing;
  const command = entry.command;
  const extensions = entry.extensions;
  const rootMarkers = entry.rootMarkers;
  if (isNew && (typeof command !== "string" || !isValidLSPCommand(command)
    || !extensionArray(extensions) || !stringArray(rootMarkers, true))) {
    warnings.push({ path: filePath, server: id, message: "Ignored new server: command, nonempty extensions, and nonempty rootMarkers are required" });
    return undefined;
  }

  const next = existing
    ? { ...copyDefinition(existing, existing.builtin), globalOverrides: new Set(existing.globalOverrides) }
    : copyDefinition({
      id,
      command: command as string,
      args: [],
      extensions: extensionArray(extensions)!,
      rootMarkers: stringArray(rootMarkers, true)!,
      languageIds: {},
      diagnosticsWaitMs: 3000,
    }, false);
  const overrides = new Set(next.globalOverrides);

  const invalid = (field: string, expected: string) => {
    warnings.push({ path: filePath, server: id, message: `Ignored invalid ${field}; expected ${expected}` });
  };

  for (const field of GLOBAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) continue;
    const value = entry[field];
    switch (field) {
      case "command":
        if (typeof value === "string" && isValidLSPCommand(value)) { next.command = value; overrides.add(field); }
        else invalid(field, "a bare executable name or absolute path");
        break;
      case "args": {
        const parsed = stringArray(value, false);
        if (parsed) { next.args = parsed; overrides.add(field); } else invalid(field, "an array of strings");
        break;
      }
      case "extensions": {
        const parsed = extensionArray(value);
        if (parsed) { next.extensions = parsed; overrides.add(field); } else invalid(field, "a nonempty array of dot-prefixed extensions");
        break;
      }
      case "rootMarkers": {
        const parsed = stringArray(value, true);
        if (parsed) { next.rootMarkers = parsed; overrides.add(field); } else invalid(field, "a nonempty array of strings");
        break;
      }
      case "languageIds": {
        const parsed = languageIds(value);
        if (parsed) { next.languageIds = parsed; overrides.add(field); } else invalid(field, "an extension-to-language-id object");
        break;
      }
      case "initializationOptions": {
        const parsed = safeClone(value);
        if (isObject(parsed)) { next.initializationOptions = parsed; overrides.add(field); }
        else invalid(field, "an object without forbidden keys");
        break;
      }
      case "diagnosticsWaitMs":
        if (typeof value === "number" && Number.isFinite(value)) next.diagnosticsWaitMs = clampDiagnosticsWaitMs(value);
        else invalid(field, "a finite number");
        break;
      case "disabled":
        if (typeof value === "boolean") next.disabled = value;
        else invalid(field, "a boolean");
        break;
    }
  }
  next.globalOverrides = overrides;
  return next;
}

export function resolveLSPConfig(options: ResolveLSPConfigOptions): LSPConfigResult {
  const warnings: LSPConfigWarning[] = [];
  const globalPath = options.globalConfigPath ?? defaultGlobalLSPConfigPath();
  const projectPath = options.projectConfigPath ?? path.join(options.cwd, options.configDirName ?? ".pi", "lsp.json");
  const resolved = new Map<string, ResolvedLSPServerConfig>();

  for (const builtin of options.builtins) {
    if (FORBIDDEN_KEYS.has(builtin.id)) continue;
    resolved.set(builtin.id, copyDefinition(builtin, true));
  }

  const global = readConfig(globalPath, warnings);
  if (global) {
    for (const [id, entry] of serverEntries(global, globalPath, warnings)) {
      try {
        const next = applyGlobalEntry(id, entry, resolved.get(id), globalPath, warnings);
        if (next) resolved.set(id, next);
      } catch (error) {
        warnings.push({
          path: globalPath,
          server: id,
          message: `Ignored malformed server config: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  const project = readConfig(projectPath, warnings);
  if (project) {
    for (const [id, entry] of serverEntries(project, projectPath, warnings)) {
      const server = resolved.get(id);
      if (!server) {
        warnings.push({ path: projectPath, server: id, message: "Ignored project server: project config cannot define servers" });
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (FORBIDDEN_KEYS.has(key) || !PROJECT_FIELDS.has(key)) {
          warnings.push({ path: projectPath, server: id, message: `Ignored privileged project field: ${key}` });
        }
      }
      if (Object.prototype.hasOwnProperty.call(entry, "disabled")) {
        if (entry.disabled === true) server.disabled = true;
        else warnings.push({ path: projectPath, server: id, message: "Ignored disabled value; project config may only set true" });
      }
      if (Object.prototype.hasOwnProperty.call(entry, "diagnosticsWaitMs")) {
        if (typeof entry.diagnosticsWaitMs === "number" && Number.isFinite(entry.diagnosticsWaitMs)) {
          server.diagnosticsWaitMs = clampDiagnosticsWaitMs(entry.diagnosticsWaitMs);
        } else {
          warnings.push({ path: projectPath, server: id, message: "Ignored invalid diagnosticsWaitMs; expected a finite number" });
        }
      }
    }
  }

  return { servers: [...resolved.values()], warnings };
}
