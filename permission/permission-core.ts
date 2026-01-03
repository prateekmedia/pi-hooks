/**
 * Core permission logic - command classification and settings
 *
 * This module contains pure functions for:
 * - Parsing shell commands
 * - Classifying commands by required permission level
 * - Detecting dangerous commands
 * - Managing settings persistence
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "shell-quote";

// ============================================================================
// TYPES
// ============================================================================

export type PermissionLevel = "minimal" | "low" | "medium" | "high" | "bypassed";

export const LEVELS: PermissionLevel[] = ["minimal", "low", "medium", "high", "bypassed"];

export const LEVEL_INDEX: Record<PermissionLevel, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  bypassed: 4,
};

export const LEVEL_INFO: Record<PermissionLevel, { label: string; desc: string }> = {
  minimal: { label: "Minimal", desc: "Read-only" },
  low: { label: "Low", desc: "File ops only" },
  medium: { label: "Medium", desc: "Dev operations" },
  high: { label: "High", desc: "Full operations" },
  bypassed: { label: "Bypassed", desc: "All checks disabled" },
};

export const LEVEL_ALLOWED_DESC: Record<PermissionLevel, string> = {
  minimal: "read-only (cat, ls, grep, git status/diff/log, npm list, version checks)",
  low: "read-only + file write/edit",
  medium: "dev ops (install packages, build, test, git commit/pull, file operations)",
  high: "full operations except dangerous commands",
  bypassed: "all operations",
};

export interface Classification {
  level: PermissionLevel;
  dangerous: boolean;
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface PermissionConfig {
  /** Override patterns to force specific permission levels */
  overrides?: {
    minimal?: string[];
    low?: string[];
    medium?: string[];
    high?: string[];
    dangerous?: string[];
  };
  /** Prefix mappings to normalize commands before classification */
  prefixMappings?: Array<{
    from: string;
    to: string;
  }>;
}

// ============================================================================
// CONFIGURATION CACHING
// ============================================================================

let configCache: PermissionConfig | null = null;
let configCacheTime = 0;
/** Cache TTL in milliseconds - balance between responsiveness and performance */
const CONFIG_CACHE_TTL = 5000; // 5 seconds

let regexCache: Map<string, RegExp> = new Map();
/** Maximum cached regex patterns to prevent memory exhaustion */
const MAX_REGEX_CACHE_SIZE = 500;

function getCachedConfig(): PermissionConfig {
  const now = Date.now();
  if (!configCache || now - configCacheTime > CONFIG_CACHE_TTL) {
    configCache = loadPermissionConfig();
    configCacheTime = now;
  }
  return configCache;
}

function getCachedRegex(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (!regex) {
    // Evict oldest entries if cache is full (simple FIFO eviction)
    if (regexCache.size >= MAX_REGEX_CACHE_SIZE) {
      const firstKey = regexCache.keys().next().value;
      if (firstKey) regexCache.delete(firstKey);
    }
    regex = globToRegex(pattern);
    regexCache.set(pattern, regex);
  }
  return regex;
}

export function invalidateConfigCache(): void {
  configCache = null;
  regexCache.clear();
}

/**
 * Validate and sanitize permission config
 * Returns a safe config object with invalid entries removed
 */
function validateConfig(config: unknown): PermissionConfig {
  if (!config || typeof config !== 'object') {
    return {};
  }

  const result: PermissionConfig = {};
  const raw = config as Record<string, unknown>;

  // Validate overrides
  if (raw.overrides && typeof raw.overrides === 'object') {
    const overrides = raw.overrides as Record<string, unknown>;
    result.overrides = {};
    
    const levels = ['minimal', 'low', 'medium', 'high', 'dangerous'] as const;
    for (const level of levels) {
      const patterns = overrides[level];
      if (Array.isArray(patterns)) {
        // Filter to only valid string patterns, limit count
        const validPatterns = patterns
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          .slice(0, 100); // Max 100 patterns per level
        if (validPatterns.length > 0) {
          result.overrides[level] = validPatterns;
        }
      }
    }
  }

  // Validate prefix mappings
  if (Array.isArray(raw.prefixMappings)) {
    const validMappings = raw.prefixMappings
      .filter((m): m is { from: string; to: string } => 
        m && typeof m === 'object' &&
        typeof (m as any).from === 'string' && (m as any).from.length > 0 &&
        typeof (m as any).to === 'string'
      )
      .slice(0, 50); // Max 50 prefix mappings
    if (validMappings.length > 0) {
      result.prefixMappings = validMappings;
    }
  }

  return result;
}

// ============================================================================
// PATTERN MATCHING
// ============================================================================

/**
 * Convert a glob-like pattern to a RegExp
 * Supports: * (any chars), ? (single char)
 * Patterns are matched against the full command string
 */
function globToRegex(pattern: string): RegExp {
  try {
    // Limit pattern complexity to prevent ReDoS
    // Reject patterns with too many consecutive * (creates .*.*.*... patterns)
    if (/\*{5,}/.test(pattern)) {
      // More than 4 consecutive * - reject to prevent exponential backtracking
      return /(?!)/;
    }

    // Escape regex special chars first (except * and ? which we handle specially)
    // Note: - is not special outside character classes, so we don't need to escape it
    let regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*') // * -> match any characters
      .replace(/\?/g, '.'); // ? -> match single character

    return new RegExp(`^${regex}$`, 'i');
  } catch {
    // Return a pattern that never matches on invalid input
    return /(?!)/;
  }
}

/**
 * Check if a command matches any pattern in the list
 */
function matchesAnyPattern(command: string, patterns: string[] | undefined | null): boolean {
  if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  return patterns.some(pattern => 
    typeof pattern === 'string' && getCachedRegex(pattern).test(command)
  );
}

/**
 * Apply prefix mappings to normalize command before classification
 * e.g., "fvm flutter build" → "flutter build"
 */
function applyPrefixMappings(
  command: string,
  mappings: PermissionConfig['prefixMappings']
): string {
  if (!mappings || !Array.isArray(mappings) || mappings.length === 0) return command;

  const trimmed = command.trim();
  const trimmedLower = trimmed.toLowerCase();

  for (const mapping of mappings) {
    // Validate mapping structure
    if (!mapping || typeof mapping.from !== 'string' || typeof mapping.to !== 'string') {
      continue;
    }
    
    const { from, to } = mapping;
    const fromLower = from.toLowerCase();

    if (trimmedLower.startsWith(fromLower)) {
      // Check for word boundary (whitespace or end of string after prefix)
      const afterPrefix = trimmed.substring(fromLower.length);
      // Use regex to check for whitespace boundary (handles tabs, multiple spaces)
      if (afterPrefix === '' || /^\s/.test(afterPrefix)) {
        // Replace prefix with mapped value, preserve rest with trimmed leading space
        const remainder = afterPrefix.replace(/^\s+/, '');
        if (to === '') {
          return remainder;
        }
        return remainder ? `${to} ${remainder}` : to;
      }
    }
  }

  return command;
}

/**
 * Check if command matches any configured override
 * Returns the override classification or null if no match
 */
function checkOverrides(
  command: string,
  overrides: PermissionConfig['overrides']
): Classification | null {
  if (!overrides) return null;

  const trimmed = command.trim();

  // Check dangerous first (highest priority)
  if (overrides.dangerous && matchesAnyPattern(trimmed, overrides.dangerous)) {
    return { level: 'high', dangerous: true };
  }

  // Check levels in order of specificity (high to low)
  if (overrides.high && matchesAnyPattern(trimmed, overrides.high)) {
    return { level: 'high', dangerous: false };
  }

  if (overrides.medium && matchesAnyPattern(trimmed, overrides.medium)) {
    return { level: 'medium', dangerous: false };
  }

  if (overrides.low && matchesAnyPattern(trimmed, overrides.low)) {
    return { level: 'low', dangerous: false };
  }

  if (overrides.minimal && matchesAnyPattern(trimmed, overrides.minimal)) {
    return { level: 'minimal', dangerous: false };
  }

  return null; // No override matched
}

// ============================================================================
// SETTINGS PERSISTENCE
// ============================================================================

function getSettingsPath(): string {
  return path.join(process.env.HOME || "", ".pi", "agent", "settings.json");
}

function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(settings: Record<string, unknown>): void {
  const settingsPath = getSettingsPath();
  const dir = path.dirname(settingsPath);
  const tempPath = `${settingsPath}.tmp`;
  
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Atomic write: write to temp file first, then rename
    fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2) + "\n");
    fs.renameSync(tempPath, settingsPath); // Atomic on POSIX systems
  } catch (e) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {}
    throw e;
  }
}

export function loadGlobalPermission(): PermissionLevel | null {
  const settings = loadSettings();
  const level = (settings.permissionLevel as string)?.toLowerCase();
  if (level && LEVELS.includes(level as PermissionLevel)) {
    return level as PermissionLevel;
  }
  return null;
}

export function saveGlobalPermission(level: PermissionLevel): void {
  const settings = loadSettings();
  settings.permissionLevel = level;
  saveSettings(settings);
}

export function loadPermissionConfig(): PermissionConfig {
  const settings = loadSettings();
  return validateConfig(settings.permissionConfig);
}

export function savePermissionConfig(config: PermissionConfig): void {
  const settings = loadSettings();
  settings.permissionConfig = config;
  saveSettings(settings);
}

// ============================================================================
// COMMAND PARSING
// ============================================================================

interface ParsedCommand {
  segments: string[][]; // Commands split by operators
  operators: string[]; // |, &&, ||, ;
  raw: string;
  hasShellTricks?: boolean;
  /** Output redirections to non-special files (>, >>) */
  writesFiles?: boolean;
}

// Shell execution commands that can run arbitrary code
const SHELL_EXECUTION_COMMANDS = new Set([
  "eval", "exec", "source", ".", // shell builtins
  "env", // can execute commands: env rm -rf /
  "command", // bypasses aliases, can execute arbitrary commands
  "builtin", // uses shell builtins directly
  // Wrapper commands that can execute arbitrary commands
  "time", "nice", "nohup", "timeout", "watch", "strace",
  // Note: xargs is handled in CONDITIONAL_WRITE_COMMANDS with smart logic
]);

// Patterns that indicate command substitution or shell tricks in raw command
// Only patterns that can actually execute arbitrary code
const SHELL_TRICK_PATTERNS = [
  /\$\((?!\()[^)]+\)/, // $(command) - command substitution (exclude $(( for arithmetic)
  /`[^`]+`/, // `command` - backtick substitution
  /<\([^)]+\)/, // <(command) - process substitution (input)
  />\([^)]+\)/, // >(command) - process substitution (output)
];

// Check if ${...} contains nested command substitution
// Simple ${VAR} is safe, but ${VAR:-$(cmd)} or ${VAR:-`cmd`} is dangerous
function hasDangerousExpansion(command: string): boolean {
  const braceExpansions = command.match(/\$\{[^}]+\}/g) || [];
  for (const expansion of braceExpansions) {
    // Check for nested $() or backticks inside ${...}
    if (/\$\(|\`/.test(expansion)) {
      return true;
    }
  }
  return false;
}

function detectShellTricks(command: string): boolean {
  // Check basic patterns first
  if (SHELL_TRICK_PATTERNS.some(pattern => pattern.test(command))) {
    return true;
  }
  // Check for dangerous ${...} expansions with nested command substitution
  if (hasDangerousExpansion(command)) {
    return true;
  }
  return false;
}

/**
 * Check if a command contains arithmetic expansion $((..))
 * Used to avoid false positives from shell-quote parsing
 */
function hasArithmeticExpansion(command: string): boolean {
  return /\$\(\(/.test(command);
}

// Output redirection operators that write to files
const OUTPUT_REDIRECTION_OPS = new Set([">", ">>", ">|", "&>", "&>>"]);

// Safe redirection targets (not actual file writes)
const SAFE_REDIRECTION_TARGETS = new Set([
  "/dev/null", "/dev/stdout", "/dev/stderr",
  "/dev/fd/1", "/dev/fd/2",
]);

function parseCommand(command: string): ParsedCommand {
  const hasShellTricks = detectShellTricks(command);
  
  // shell-quote can throw on complex patterns it doesn't understand
  // In that case, treat the command as having shell tricks (require high permission)
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    // Parse failed - treat as dangerous
    return {
      segments: [],
      operators: [],
      raw: command,
      hasShellTricks: true
    };
  }

  const segments: string[][] = [];
  const operators: string[] = [];
  let currentSegment: string[] = [];
  let foundCommandSubstitution = false;
  let writesFiles = false;

  // Redirection operators - these don't start new command segments
  const REDIRECTION_OPS = new Set([">", "<", ">>", ">&", "<&", ">|", "<>", "&>", "&>>"]);
  let pendingOutputRedirect = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    
    if (pendingOutputRedirect) {
      // This token is a redirection target
      pendingOutputRedirect = false;
      if (typeof token === "string") {
        // Check if this is writing to a real file (not /dev/null etc.)
        if (!SAFE_REDIRECTION_TARGETS.has(token) && !token.startsWith("/dev/fd/")) {
          writesFiles = true;
        }
      }
      continue;
    }
    
    if (typeof token === "string") {
      currentSegment.push(token);
    } else if (token && typeof token === "object") {
      if ("op" in token) {
        const op = token.op as string;
        if (REDIRECTION_OPS.has(op)) {
          // Check if this is an output redirection
          if (OUTPUT_REDIRECTION_OPS.has(op)) {
            pendingOutputRedirect = true;
          } else {
            // Input redirection or fd duplication - skip next token
            // For >&, <& we need to check if it's fd duplication (2>&1) or file redirect
            if (op === ">&" || op === "<&") {
              const nextToken = tokens[i + 1];
              if (typeof nextToken === "string" && /^\d+$/.test(nextToken)) {
                // fd duplication like 2>&1, skip it
                i++;
              } else {
                // File redirect like >&file
                pendingOutputRedirect = true;
              }
            }
          }
        } else {
          // Only treat actual command separators as segment boundaries
          // ( and ) are grouping/subshell/arithmetic operators, not separators
          const COMMAND_SEPARATORS = new Set(["|", "&&", "||", ";", "&"]);
          if (COMMAND_SEPARATORS.has(op)) {
            if (currentSegment.length > 0) {
              segments.push(currentSegment);
              currentSegment = [];
            }
            operators.push(op);
          }
          // Ignore ( and ) - they don't create new command segments
        }
      } else if ("comment" in token) {
        // Comment - ignore
      } else {
        // shell-quote returns special objects for:
        // - { op: 'glob', pattern: '*.js' } - globs
        // - { op: string } - operators
        // Any other object type indicates shell parsing complexity
        // that we should treat as potentially dangerous
        foundCommandSubstitution = true;
      }
    }
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return {
    segments,
    operators,
    raw: command,
    hasShellTricks: hasShellTricks || foundCommandSubstitution,
    writesFiles
  };
}

function getCommandName(tokens: string[]): string {
  if (tokens.length === 0) return "";

  let cmd = tokens[0];

  // Strip path prefix
  if (cmd.includes("/")) {
    cmd = cmd.split("/").pop() || cmd;
  }

  // Strip leading backslash (alias bypass)
  if (cmd.startsWith("\\")) {
    cmd = cmd.slice(1);
  }

  return cmd.toLowerCase();
}

// ============================================================================
// DANGEROUS COMMAND DETECTION
// ============================================================================

function isDangerousCommand(tokens: string[]): boolean {
  if (tokens.length === 0) return false;

  const cmd = getCommandName(tokens);
  const args = tokens.slice(1);
  const argsStr = args.join(" ");

  // sudo - always dangerous
  if (cmd === "sudo") return true;

  // rm with recursive + force
  if (cmd === "rm") {
    let hasRecursive = false;
    let hasForce = false;

    for (const arg of args) {
      if (arg === "--recursive") hasRecursive = true;
      if (arg === "--force") hasForce = true;
      if (arg.startsWith("-") && !arg.startsWith("--")) {
        if (arg.includes("r") || arg.includes("R")) hasRecursive = true;
        if (arg.includes("f")) hasForce = true;
      }
    }

    if (hasRecursive && hasForce) return true;
  }

  // chmod 777 or a+rwx
  if (cmd === "chmod") {
    if (argsStr.includes("777") || argsStr.includes("a+rwx")) return true;
  }

  // dd to device
  if (cmd === "dd") {
    if (argsStr.match(/of=\/dev\//)) return true;
  }

  // Dangerous system commands
  if (["fdisk", "parted", "format"].includes(cmd)) return true;
  if (cmd.startsWith("mkfs")) return true; // mkfs, mkfs.ext4, mkfs.xfs, etc.

  // Shutdown/reboot
  if (["shutdown", "reboot", "halt", "poweroff", "init"].includes(cmd)) return true;

  // Fork bomb pattern
  if (tokens.join("").includes(":(){ :|:& };:")) return true;

  return false;
}

// ============================================================================
// LEVEL CLASSIFICATION
// ============================================================================

// Common redirection targets (treated as read-only)
const REDIRECTION_TARGETS = new Set([
  "/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr",
  "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom",
  "/dev/fd", "/dev/tty", "/dev/ptmx",
]);

// File descriptor numbers used in redirections (e.g., 2>&1)
const FD_NUMBERS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

// MINIMAL level - read-only commands
const MINIMAL_COMMANDS = new Set([
  // File reading
  "cat", "less", "more", "head", "tail", "bat", "tac",
  // Directory listing/navigation
  "ls", "tree", "pwd", "dir", "vdir", "cd", "pushd", "popd", "dirs",
  // Search (note: find handled specially due to -exec/-delete)
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "locate", "which", "whereis",
  // Info
  "echo", "printf", "whoami", "id", "date", "cal", "uname", "hostname", "uptime",
  "type", "file", "stat", "wc", "du", "df", "free",
  "ps", "top", "htop", "pgrep", "sleep",
  // Man/help
  "man", "help", "info",
  // Pipeline utilities (note: xargs, tee handled specially - they can write/execute)
  "sort", "uniq", "cut", "awk", "sed", "tr", "column", "paste", "join",
  "comm", "diff", "cmp", "patch",
  // Shell test commands (read-only conditionals)
  "test", "[", "[[", "true", "false",
]);

// Commands that can write files based on arguments
// find: -exec, -execdir, -ok, -okdir, -delete can modify filesystem
// xargs: executes commands with input as arguments (but safe if running read-only commands)
// tee: writes to files (but read-only when used with /dev/null or --)

/**
 * Extract the command that xargs will execute.
 * Parses xargs options to find the first non-option argument.
 * Returns null if no command specified (xargs defaults to /bin/echo).
 */
function extractXargsCommand(tokens: string[]): string | null {
  const args = tokens.slice(1); // Skip 'xargs' itself

  // xargs options that consume the next argument
  const OPTIONS_WITH_ARG = new Set(["-I", "-d", "-E", "-L", "-n", "-P", "-s", "-a"]);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // End of options marker
    if (arg === "--") {
      i++;
      break;
    }

    // Not an option - this is the command
    if (!arg.startsWith("-")) {
      break;
    }

    // Long options (--null, --max-args=5, etc.)
    if (arg.startsWith("--")) {
      // Long options either are flags or use = for values, so just skip
      i++;
      continue;
    }

    // Short option that takes a required argument
    // Could be: -I {} (separate) or -I{} (attached)
    const optLetter = arg.substring(0, 2); // e.g., "-I"
    if (OPTIONS_WITH_ARG.has(optLetter)) {
      if (arg.length > 2) {
        // Argument attached: -I{} or -n10
        i++;
      } else {
        // Argument is next token: -I {}
        i += 2;
      }
      continue;
    }

    // -i and -e can have optional attached argument (deprecated forms)
    // -i[replstr], -e[eof-str]
    if (arg.startsWith("-i") || arg.startsWith("-e")) {
      i++;
      continue;
    }

    // Other short options are flags (can be combined): -0, -t, -p, -r, -x
    // e.g., -0tr means -0 -t -r
    i++;
  }

  // Return the command if found
  if (i < args.length) {
    const cmd = args[i];
    // Strip path prefix (e.g., /usr/bin/cat -> cat)
    if (cmd.includes("/")) {
      return cmd.split("/").pop()?.toLowerCase() || null;
    }
    return cmd.toLowerCase();
  }

  // No command found - xargs defaults to /bin/echo (safe)
  return null;
}

const CONDITIONAL_WRITE_COMMANDS: Record<string, (tokens: string[]) => boolean> = {
  find: (tokens) => {
    const dangerousFlags = ["-exec", "-execdir", "-ok", "-okdir", "-delete"];
    return tokens.some(t => dangerousFlags.includes(t.toLowerCase()));
  },
  xargs: (tokens) => {
    // xargs executes commands with input as arguments
    // Safe if running a read-only command from MINIMAL_COMMANDS
    const xargsCmd = extractXargsCommand(tokens);

    // No command = defaults to /bin/echo (safe, just prints)
    if (xargsCmd === null) return false;

    // Check if the command xargs will run is read-only
    if (MINIMAL_COMMANDS.has(xargsCmd)) return false;

    // Unknown or non-minimal command - not safe
    return true;
  },
  tee: (tokens) => {
    // tee writes to files unless only used with /dev/null or --
    const args = tokens.slice(1).filter(t => !t.startsWith("-"));
    if (args.length === 0) return false; // tee with no file args writes to stdout only
    // Check if all file args are /dev/null
    return !args.every(a => a === "/dev/null");
  },
};

const MINIMAL_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "remote", "tag",
  "ls-files", "ls-tree", "cat-file", "rev-parse", "describe",
  "shortlog", "blame", "annotate", "whatchanged", "reflog",
  "fetch", // read-only: just downloads refs, doesn't change working tree
]);

const MINIMAL_PACKAGE_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(["list", "ls", "info", "view", "outdated", "audit", "explain", "why", "search"]),
  yarn: new Set(["list", "info", "why", "outdated", "audit"]),
  pnpm: new Set(["list", "ls", "outdated", "audit", "why"]),
  bun: new Set(["pm", "ls"]),
  pip: new Set(["list", "show", "freeze", "check"]),
  pip3: new Set(["list", "show", "freeze", "check"]),
  cargo: new Set(["tree", "metadata", "search", "info"]),
  go: new Set(["list", "version", "env"]),
  gem: new Set(["list", "info", "search", "query"]),
  composer: new Set(["show", "info", "search", "outdated", "audit"]),
  dotnet: new Set(["list", "nuget"]),
  flutter: new Set(["doctor", "devices", "config"]),
  dart: new Set(["info"]),
};

function isMinimalLevel(tokens: string[]): boolean {
  if (tokens.length === 0) return true;

  const cmd = getCommandName(tokens);
  const fullCmd = tokens[0]; // Keep full path for checking redirection targets
  const subCmd = tokens.length > 1 ? tokens[1].toLowerCase() : "";

  // Check if this is a file descriptor number from redirection parsing (e.g., "1" from 2>&1)
  if (tokens.length === 1 && FD_NUMBERS.has(fullCmd)) return true;

  // Check if this is a common redirection target (e.g., /dev/null)
  if (REDIRECTION_TARGETS.has(fullCmd)) return true;

  // Check conditional write commands (find with -exec, xargs, tee with files)
  const conditionalCheck = CONDITIONAL_WRITE_COMMANDS[cmd];
  if (conditionalCheck) {
    // If the command would write/execute, it's not minimal level
    if (conditionalCheck(tokens)) {
      return false;
    }
    // Otherwise it's safe (e.g., find without -exec, tee to /dev/null)
    return true;
  }

  // Basic read-only commands
  if (MINIMAL_COMMANDS.has(cmd)) return true;

  // Version checks
  if (tokens.includes("--version") || tokens.includes("-v") || tokens.includes("-V")) {
    return true;
  }

  // Git read operations
  if (cmd === "git" && subCmd && MINIMAL_GIT_SUBCOMMANDS.has(subCmd)) {
    // Some git commands are only read-only without additional args
    // e.g., "git branch" lists branches (minimal), "git branch new" creates (medium)
    // e.g., "git tag" lists tags (minimal), "git tag v1.0" creates (medium)
    const READ_ONLY_WITHOUT_ARGS = new Set(["branch", "tag", "remote"]);
    if (READ_ONLY_WITHOUT_ARGS.has(subCmd)) {
      // Check if there are args beyond flags (starting with -)
      const nonFlagArgs = tokens.slice(2).filter(t => !t.startsWith("-"));
      if (nonFlagArgs.length > 0) {
        return false; // Has args, not read-only
      }
    }
    return true;
  }

  // Package manager read operations
  if (MINIMAL_PACKAGE_SUBCOMMANDS[cmd]?.has(subCmd)) {
    return true;
  }

  return false;
}

// MEDIUM level - build/install/test operations only (NOT running code)
const MEDIUM_PACKAGE_PATTERNS: Array<[string, RegExp]> = [
  // Node.js - install, build, test only (NOT run/start/exec which execute arbitrary code)
  ["npm", /^(install|ci|add|remove|uninstall|update|rebuild|dedupe|prune|link|pack|test|build)$/],
  ["yarn", /^(install|add|remove|upgrade|import|link|pack|test|build)$/],
  ["pnpm", /^(install|add|remove|update|link|pack|test|build)$/],
  ["bun", /^(install|add|remove|update|link|test|build)$/],
  // npx/bunx/pnpx run arbitrary packages - HIGH (not included here)

  // Python - install/build only (NOT running scripts)
  ["pip", /^install$/],
  ["pip3", /^install$/],
  ["pipenv", /^(install|update|sync|lock|uninstall)$/],
  ["poetry", /^(install|add|remove|update|lock|build)$/],
  ["conda", /^(install|update|remove|create)$/],
  ["uv", /^(pip|sync|lock)$/],
  // python/python3 run arbitrary code - HIGH (not included here)
  ["pytest", /./], // test runner is safe

  // Rust - build/test/lint only (NOT cargo run)
  ["cargo", /^(install|add|remove|fetch|update|build|test|check|clippy|fmt|doc|bench|clean)$/],
  ["rustfmt", /./],
  // rustc compiles but doesn't run - medium
  ["rustc", /./],

  // Go - build/test only (NOT go run)
  ["go", /^(get|mod|build|test|generate|fmt|vet|clean|install)$/],

  // Ruby - install/build only
  ["gem", /^install$/],
  ["bundle", /^(install|update|add|remove|binstubs)$/],
  ["bundler", /^(install|update|add|remove)$/],
  // CocoaPods - dependency management only
  ["pod", /^(install|update|repo)$/],
  // rake/rails can run arbitrary code - HIGH (not included here)
  ["rspec", /./], // test runner

  // PHP - install only
  ["composer", /^(install|require|remove|update|dump-autoload)$/],
  // php runs code - HIGH (not included here)
  ["phpunit", /./], // test runner

  // Java/Kotlin - compile/test only (NOT run)
  ["mvn", /^(install|compile|test|package|clean|dependency|verify)$/],
  ["gradle", /^(build|test|clean|assemble|dependencies|check)$/],
  // gradlew can run arbitrary tasks - HIGH (not included here)

  // .NET - build/test only (NOT run/watch)
  ["dotnet", /^(restore|add|build|test|clean|publish|pack|new)$/],
  ["nuget", /^install$/],

  // Dart/Flutter - build/test only (NOT run)
  ["dart", /^(pub|compile|test|analyze|format|fix)$/],
  ["flutter", /^(pub|build|test|analyze|clean|create|doctor)$/],
  ["pub", /^(get|upgrade|downgrade|cache|deps)$/],

  // Swift - build/test only (NOT run)
  ["swift", /^(package|build|test)$/],
  ["swiftc", /./],

  // Elixir - build/test only (NOT run)
  ["mix", /^(deps|compile|test|ecto|phx\.gen)$/],
  // elixir runs code - HIGH (not included here)

  // Haskell - build/test only (NOT run)
  ["cabal", /^(install|build|test|update)$/],
  ["stack", /^(install|build|test|setup)$/],
  // ghc compiles but doesn't run - medium
  ["ghc", /./],

  // Others
  ["nimble", /^install$/],
  ["zig", /^(build|test|fetch)$/],
  ["cmake", /./],
  ["make", /./],
  ["ninja", /./],
  ["meson", /./],

  // Linters/formatters - static analysis only (MEDIUM)
  ["eslint", /./],
  ["prettier", /./],
  ["black", /./],
  ["flake8", /./],
  ["pylint", /./],
  ["ruff", /./],
  ["pyflakes", /./],
  ["bandit", /./],
  ["mypy", /./],
  ["pyright", /./],
  ["tsc", /./],
  ["tslint", /./],
  ["standard", /./],
  ["xo", /./],
  ["rubocop", /./],
  ["standardrb", /./],
  ["reek", /./],
  ["brakeman", /./],
  ["golangci-lint", /./],
  ["gofmt", /./],
  ["go vet", /./],
  ["golint", /./],
  ["staticcheck", /./],
  ["errcheck", /./],
  ["misspell", /./],
  ["swiftlint", /./],
  ["swiftformat", /./],
  ["ktlint", /./],
  ["detekt", /./],
  ["dartanalyzer", /./], // dart analyze alternative name
  ["dartfmt", /./],
  ["clang-tidy", /./],
  ["clang-format", /./],
  ["cppcheck", /./],
  ["checkstyle", /./],
  ["pmd", /./],
  ["spotbugs", /./],
  ["sonarqube", /./],
  ["phpcs", /./],
  ["phpmd", /./],
  ["phpstan", /./],
  ["psalm", /./],
  ["php-cs-fixer", /./],
  ["luacheck", /./],
  ["shellcheck", /./],
  ["checkov", /./],
  ["tflint", /./],
  ["buf", /./], // protobuf linter
  ["sqlfluff", /./],
  ["yamllint", /./],
  ["markdownlint", /./],
  ["djlint", /./],
  ["djhtml", /./],
  ["commitlint", /./],

  // Test runners
  ["jest", /./],
  ["mocha", /./],
  ["vitest", /./],

  // File ops
  ["mkdir", /./],
  ["touch", /./],
  ["cp", /./],
  ["mv", /./],
  ["ln", /./],

  // Database (local dev)
  ["prisma", /^(generate|migrate|db|studio)$/],
  ["sequelize", /^(db|migration)$/],
  ["typeorm", /^(migration)$/],
];

const MEDIUM_GIT_SUBCOMMANDS = new Set([
  "add", "commit", "pull", "checkout", "switch", "branch",
  "merge", "rebase", "cherry-pick", "stash", "revert", "tag",
  "rm", "mv", "reset", "clone", // reset without --hard, clone is reversible
  // NOT included (irreversible):
  // - clean: permanently deletes untracked files
  // - restore: can discard uncommitted changes permanently
]);

// Safe npm/yarn/pnpm/bun run scripts (build, test, lint - not dev, start, serve)
const SAFE_RUN_SCRIPTS = new Set([
  "build", "compile", "test", "lint", "format", "fmt", "check", "typecheck",
  "type-check", "types", "validate", "verify", "prepare", "prepublish",
  "prepublishOnly", "prepack", "postpack", "clean", "lint:fix", "format:check",
  "build:prod", "build:dev", "build:production", "build:development",
  "test:unit", "test:integration", "test:e2e", "test:coverage",
]);

// Scripts that run servers or arbitrary code
const UNSAFE_RUN_SCRIPTS = new Set([
  "start", "dev", "develop", "serve", "server", "watch", "preview",
  "start:dev", "start:prod", "dev:server",
]);

function isSafeRunScript(script: string): boolean {
  const s = script.toLowerCase();
  // Check explicit safe list
  if (SAFE_RUN_SCRIPTS.has(s)) return true;
  // Check if starts with safe prefix
  if (s.startsWith("build") || s.startsWith("test") || s.startsWith("lint") || 
      s.startsWith("format") || s.startsWith("check") || s.startsWith("type")) {
    return true;
  }
  // Check explicit unsafe list
  if (UNSAFE_RUN_SCRIPTS.has(s)) return false;
  // Check unsafe prefixes
  if (s.startsWith("start") || s.startsWith("dev") || s.startsWith("serve") || 
      s.startsWith("watch")) {
    return false;
  }
  // Default: unknown scripts are unsafe
  return false;
}

function isMediumLevel(tokens: string[]): boolean {
  if (tokens.length === 0) return false;

  const cmd = getCommandName(tokens);
  const subCmd = tokens.length > 1 ? tokens[1].toLowerCase() : "";
  const thirdArg = tokens.length > 2 ? tokens[2] : "";

  // Git local operations (not push)
  if (cmd === "git") {
    if (subCmd === "push") return false; // push is HIGH
    if (subCmd === "reset" && tokens.includes("--hard")) return false; // hard reset is HIGH
    if (MEDIUM_GIT_SUBCOMMANDS.has(subCmd)) return true;
  }

  // Handle npm/yarn/pnpm/bun run <script> specially
  if (["npm", "yarn", "pnpm", "bun"].includes(cmd) && subCmd === "run") {
    // Need a script name
    if (!thirdArg || thirdArg.startsWith("-")) return false;
    return isSafeRunScript(thirdArg);
  }

  // Package managers and build tools
  for (const [pattern, subPattern] of MEDIUM_PACKAGE_PATTERNS) {
    if (cmd === pattern) {
      if (!subCmd || subPattern.test(subCmd)) {
        return true;
      }
    }
  }

  return false;
}

// HIGH level - git push, remote operations
function isHighLevel(tokens: string[]): boolean {
  if (tokens.length === 0) return false;

  const cmd = getCommandName(tokens);
  const subCmd = tokens.length > 1 ? tokens[1].toLowerCase() : "";
  const argsStr = tokens.slice(1).join(" ");

  // Git push
  if (cmd === "git" && subCmd === "push") return true;

  // Git reset --hard
  if (cmd === "git" && subCmd === "reset" && tokens.includes("--hard")) return true;

  // curl/wget piped to shell (detected at pipeline level)
  if (cmd === "curl" || cmd === "wget") return true;

  // Running remote scripts
  if (cmd === "bash" || cmd === "sh" || cmd === "zsh") {
    if (argsStr.includes("http://") || argsStr.includes("https://")) return true;
  }

  // Docker operations
  if (cmd === "docker" && ["push", "login", "logout"].includes(subCmd)) return true;

  // Deployment tools
  if (["kubectl", "helm", "terraform", "pulumi", "ansible"].includes(cmd)) return true;

  // SSH/SCP
  if (["ssh", "scp", "rsync"].includes(cmd)) return true;

  return false;
}

// ============================================================================
// CLASSIFY COMMAND
// ============================================================================

function classifySegment(tokens: string[]): Classification {
  if (tokens.length === 0) {
    return { level: "minimal", dangerous: false };
  }

  const cmd = getCommandName(tokens);

  // Shell execution commands that can run arbitrary code - always HIGH
  // These bypass normal command classification since they execute their arguments
  if (SHELL_EXECUTION_COMMANDS.has(cmd)) {
    return { level: "high", dangerous: false };
  }

  if (isDangerousCommand(tokens)) {
    return { level: "high", dangerous: true };
  }

  if (isMinimalLevel(tokens)) {
    return { level: "minimal", dangerous: false };
  }

  if (isMediumLevel(tokens)) {
    return { level: "medium", dangerous: false };
  }

  if (isHighLevel(tokens)) {
    return { level: "high", dangerous: false };
  }

  // Default: require HIGH for unknown commands
  return { level: "high", dangerous: false };
}

export function classifyCommand(command: string, config?: PermissionConfig): Classification {
  // Load config if not provided (for testing)
  const effectiveConfig = config ?? getCachedConfig();

  // Step 1: Apply prefix normalization
  const normalizedCommand = applyPrefixMappings(command, effectiveConfig.prefixMappings);

  const parsed = parseCommand(normalizedCommand);

  // If command contains shell tricks (command substitution, backticks, etc.),
  // require HIGH level as we cannot reliably classify the embedded commands
  if (parsed.hasShellTricks) {
    return { level: "high", dangerous: false };
  }

  // Step 2: Check for override on NORMALIZED command (consistent with classification)
  const override = checkOverrides(normalizedCommand, effectiveConfig.overrides);
  if (override) {
    return override;
  }

  let maxLevel: PermissionLevel = "minimal";
  let dangerous = false;

  // If command writes to files via redirection (>, >>), require at least LOW
  if (parsed.writesFiles) {
    maxLevel = "low";
  }

  for (let i = 0; i < parsed.segments.length; i++) {
    const segment = parsed.segments[i];
    const segmentClass = classifySegment(segment);

    if (segmentClass.dangerous) {
      dangerous = true;
    }

    if (LEVEL_INDEX[segmentClass.level] > LEVEL_INDEX[maxLevel]) {
      maxLevel = segmentClass.level;
    }

    // Check for piping to shell
    if (i < parsed.segments.length - 1 && parsed.operators[i] === "|") {
      const nextCmd = getCommandName(parsed.segments[i + 1]);
      if (["bash", "sh", "zsh", "node", "python", "python3", "ruby", "perl"].includes(nextCmd)) {
        maxLevel = "high";
      }
    }
  }

  return { level: maxLevel, dangerous };
}
