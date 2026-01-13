/**
 * Permission Extension for pi-coding-agent
 *
 * Implements layered permission control.
 *
 * Interactive mode:
 *   Use `/permission` command to view or change the level.
 *   Use `/permission-mode` to switch between ask vs block.
 *   When changing via command, you'll be asked: session-only or global?
 *
 * Print mode (pi -p):
 *   Set PI_PERMISSION_LEVEL env var: PI_PERMISSION_LEVEL=medium pi -p "task"
 *   Operations beyond level will exit with helpful error message.
 *   Use PI_PERMISSION_LEVEL=bypassed for CI/containers (dangerous!)
 *
 * Levels:
 *   minimal - Read-only mode (default)
 *             ✅ Read files, ls, grep, git status/log/diff
 *             ❌ No file modifications, no commands with side effects
 *
 *   low    - File operations only
 *            ✅ Create/edit files in project directory
 *            ❌ No package installs, no git commits, no builds
 *
 *   medium - Development operations
 *            ✅ npm/pip install, git commit/pull, make/build
 *            ❌ No git push, no sudo, no production changes
 *
 *   high   - Full operations
 *            ✅ git push, deployments, scripts
 *            ⚠️ Still prompts for destructive commands (rm -rf, etc.)
 *
 * Usage:
 *   pi --extension ./permission-hook.ts
 *
 * Or add to ~/.pi/agent/extensions/ or .pi/extensions/ for automatic loading.
 */

import { exec } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type PermissionLevel,
  type PermissionMode,
  LEVELS,
  LEVEL_INDEX,
  LEVEL_INFO,
  LEVEL_ALLOWED_DESC,
  PERMISSION_MODES,
  PERMISSION_MODE_INFO,
  loadGlobalPermission,
  saveGlobalPermission,
  loadGlobalPermissionMode,
  saveGlobalPermissionMode,
  classifyCommand,
  loadPermissionConfig,
  savePermissionConfig,
  invalidateConfigCache,
  type PermissionConfig,
} from "./permission-core.js";

// Re-export types and constants needed by the hook
export {
  type PermissionLevel,
  type PermissionMode,
  LEVELS,
  LEVEL_INFO,
  PERMISSION_MODES,
  PERMISSION_MODE_INFO,
};

// ============================================================================
// SOUND NOTIFICATION
// ============================================================================

function playPermissionSound(): void {
  const isMac = process.platform === "darwin";

  if (isMac) {
    exec('afplay /System/Library/Sounds/Funk.aiff 2>/dev/null', (err) => {
      if (err) process.stdout.write("\x07");
    });
  } else {
    process.stdout.write("\x07");
  }
}

// ============================================================================
// STATUS TEXT
// ============================================================================

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

const LEVEL_COLORS: Record<PermissionLevel, string> = {
  minimal: RED,
  low: YELLOW,
  medium: CYAN,
  high: GREEN,
  bypassed: DIM,
};

function getStatusText(level: PermissionLevel): string {
  const info = LEVEL_INFO[level];
  const color = LEVEL_COLORS[level];
  return `${BOLD}${color}${info.label}${RESET} ${DIM}- ${info.desc}${RESET}`;
}

// ============================================================================
// MODE DETECTION
// ============================================================================

function getPiModeFromArgv(argv: string[] = process.argv): string | undefined {
  // Support both: --mode rpc and --mode=rpc
  const eq = argv.find((a) => a.startsWith("--mode="));
  if (eq) return eq.slice("--mode=".length);

  const idx = argv.indexOf("--mode");
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];

  return undefined;
}

function hasInteractiveUI(ctx: any): boolean {
  if (!ctx?.hasUI) return false;

  // In non-interactive modes (rpc/json/print), UI prompts are not desired.
  // We still allow notifications, but block instead of asking.
  const mode = getPiModeFromArgv()?.toLowerCase();
  if (mode && mode !== "interactive") return false;

  return true;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export interface PermissionState {
  currentLevel: PermissionLevel;
  isSessionOnly: boolean;
  permissionMode: PermissionMode;
  isModeSessionOnly: boolean;
}

export function createInitialState(): PermissionState {
  return {
    currentLevel: "minimal",
    isSessionOnly: false,
    permissionMode: "ask",
    isModeSessionOnly: false,
  };
}

function setLevel(
  state: PermissionState,
  level: PermissionLevel,
  saveGlobally: boolean,
  ctx: any
): void {
  state.currentLevel = level;
  state.isSessionOnly = !saveGlobally;
  if (saveGlobally) {
    saveGlobalPermission(level);
  }
  if (ctx.ui?.setStatus) {
    ctx.ui.setStatus("authority", getStatusText(level));
  }
}

function setMode(
  state: PermissionState,
  mode: PermissionMode,
  saveGlobally: boolean,
  ctx: any
): void {
  state.permissionMode = mode;
  state.isModeSessionOnly = !saveGlobally;
  if (saveGlobally) {
    saveGlobalPermissionMode(mode);
  }
}

// ============================================================================
// HANDLERS
// ============================================================================

/** Handle /permission config subcommand */
async function handleConfigSubcommand(
  state: PermissionState,
  args: string,
  ctx: any
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const action = parts[0];

  if (action === "show") {
    const config = loadPermissionConfig();
    const configStr = JSON.stringify(config, null, 2);
    ctx.ui.notify(`Permission Config:\n${configStr}`, "info");
    return;
  }

  if (action === "reset") {
    savePermissionConfig({});
    invalidateConfigCache();
    ctx.ui.notify("Permission config reset to defaults", "info");
    return;
  }

  // Show help
  const help = `Usage: /permission config <action>

Actions:
  show  - Display current configuration
  reset - Reset to default configuration

Edit ~/.pi/agent/settings.json directly for full control:

{
  "permissionConfig": {
    "overrides": {
      "minimal": ["tmux list-*", "tmux show-*"],
      "medium": ["tmux *", "screen *"],
      "high": ["rm -rf *"],
      "dangerous": ["dd if=* of=/dev/*"]
    },
    "prefixMappings": [
      { "from": "fvm flutter", "to": "flutter" },
      { "from": "nvm exec", "to": "" }
    ]
  }
}`;

  ctx.ui.notify(help, "info");
}

/** Handle /permission command */
export async function handlePermissionCommand(
  state: PermissionState,
  args: string,
  ctx: any
): Promise<void> {
  const arg = args.trim().toLowerCase();

  // Handle config subcommand
  if (arg === "config" || arg.startsWith("config ")) {
    const configArgs = arg.replace(/^config\s*/, '');
    await handleConfigSubcommand(state, configArgs, ctx);
    return;
  }

  // Direct level set: /permission medium
  if (arg && LEVELS.includes(arg as PermissionLevel)) {
    const newLevel = arg as PermissionLevel;

    if (hasInteractiveUI(ctx)) {
      const scope = await ctx.ui.select("Save permission level to:", [
        "Session only",
        "Global (persists)",
      ]);
      if (!scope) return;

      setLevel(state, newLevel, scope === "Global (persists)", ctx);
      const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
      ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}${saveMsg}`, "info");
    } else {
      setLevel(state, newLevel, false, ctx);
      ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}`, "info");
    }
    return;
  }

  // Show current level (no UI)
  if (!hasInteractiveUI(ctx)) {
    ctx.ui.notify(
      `Current permission: ${LEVEL_INFO[state.currentLevel].label} (${LEVEL_INFO[state.currentLevel].desc})`,
      "info"
    );
    return;
  }

  // Show selector
  const options = LEVELS.map((level) => {
    const info = LEVEL_INFO[level];
    const marker = level === state.currentLevel ? " ← current" : "";
    return `${info.label}: ${info.desc}${marker}`;
  });

  const choice = await ctx.ui.select("Select permission level", options);
  if (!choice) return;

  const selectedLabel = choice.split(":")[0].trim();
  const newLevel = LEVELS.find((l) => LEVEL_INFO[l].label === selectedLabel);
  if (!newLevel || newLevel === state.currentLevel) return;

  const scope = await ctx.ui.select("Save to:", ["Session only", "Global (persists)"]);
  if (!scope) return;

  setLevel(state, newLevel, scope === "Global (persists)", ctx);
  const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
  ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}${saveMsg}`, "info");
}

/** Handle /permission-mode command */
export async function handlePermissionModeCommand(
  state: PermissionState,
  args: string,
  ctx: any
): Promise<void> {
  const arg = args.trim().toLowerCase();

  if (arg && PERMISSION_MODES.includes(arg as PermissionMode)) {
    const newMode = arg as PermissionMode;

    if (hasInteractiveUI(ctx)) {
      const scope = await ctx.ui.select("Save permission mode to:", [
        "Session only",
        "Global (persists)",
      ]);
      if (!scope) return;

      setMode(state, newMode, scope === "Global (persists)", ctx);
      const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
      ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}${saveMsg}`, "info");
    } else {
      setMode(state, newMode, false, ctx);
      ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}`, "info");
    }
    return;
  }

  if (!hasInteractiveUI(ctx)) {
    ctx.ui.notify(
      `Current permission mode: ${PERMISSION_MODE_INFO[state.permissionMode].label} (${PERMISSION_MODE_INFO[state.permissionMode].desc})`,
      "info"
    );
    return;
  }

  const options = PERMISSION_MODES.map((mode) => {
    const info = PERMISSION_MODE_INFO[mode];
    const marker = mode === state.permissionMode ? " ← current" : "";
    return `${info.label}: ${info.desc}${marker}`;
  });

  const choice = await ctx.ui.select("Select permission mode", options);
  if (!choice) return;

  const selectedLabel = choice.split(":")[0].trim();
  const newMode = PERMISSION_MODES.find((m) => PERMISSION_MODE_INFO[m].label === selectedLabel);
  if (!newMode || newMode === state.permissionMode) return;

  const scope = await ctx.ui.select("Save to:", ["Session only", "Global (persists)"]);
  if (!scope) return;

  setMode(state, newMode, scope === "Global (persists)", ctx);
  const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
  ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}${saveMsg}`, "info");
}

/** Handle session_start - initialize level and show status */
export function handleSessionStart(state: PermissionState, ctx: any): void {
  // Check env var first (for print mode)
  const envLevel = process.env.PI_PERMISSION_LEVEL?.toLowerCase();
  if (envLevel && LEVELS.includes(envLevel as PermissionLevel)) {
    state.currentLevel = envLevel as PermissionLevel;
  } else {
    const globalLevel = loadGlobalPermission();
    if (globalLevel) {
      state.currentLevel = globalLevel;
    }
  }

  if (ctx.hasUI) {
    const globalMode = loadGlobalPermissionMode();
    if (globalMode) {
      state.permissionMode = globalMode;
    }
  }

  if (ctx.hasUI) {
    if (ctx.ui?.setStatus) {
      ctx.ui.setStatus("authority", getStatusText(state.currentLevel));
    }
    if (state.currentLevel === "bypassed") {
      ctx.ui.notify("⚠️ Permission bypassed - all checks disabled!", "warning");
    } else {
      ctx.ui.notify(`Permission: ${LEVEL_INFO[state.currentLevel].label} (use /permission to change)`, "info");
    }
    if (state.permissionMode === "block") {
      ctx.ui.notify("Permission mode: Block (use /permission-mode to change)", "info");
    }
  }
}

/** Handle bash tool_call - check permission and prompt if needed */
export async function handleBashToolCall(
  state: PermissionState,
  command: string,
  ctx: any
): Promise<{ block: true; reason: string } | undefined> {
  if (state.currentLevel === "bypassed") return undefined;

  const classification = classifyCommand(command);

  // Dangerous commands - always prompt unless in block mode
  if (classification.dangerous) {
    if (!hasInteractiveUI(ctx)) {
      return {
        block: true,
        reason: `Dangerous command requires confirmation: ${command}
User can re-run with: PI_PERMISSION_LEVEL=bypassed pi -p "..."`
      };
    }

    if (state.permissionMode === "block") {
      return {
        block: true,
        reason: `Blocked by permission mode (block). Dangerous command: ${command}
Use /permission-mode ask to enable confirmations.`
      };
    }

    playPermissionSound();
    const choice = await ctx.ui.select(
      `⚠️ Dangerous command`,
      ["Allow once", "Cancel"]
    );

    if (choice !== "Allow once") {
      return { block: true, reason: "Cancelled" };
    }
    return undefined;
  }

  // Check level
  const requiredIndex = LEVEL_INDEX[classification.level];
  const currentIndex = LEVEL_INDEX[state.currentLevel];

  if (requiredIndex <= currentIndex) return undefined;

  const requiredLevel = classification.level;
  const requiredInfo = LEVEL_INFO[requiredLevel];

  // Print mode: block
  if (!hasInteractiveUI(ctx)) {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}). Command: ${command}
Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
User can re-run with: PI_PERMISSION_LEVEL=${requiredLevel} pi -p "..."`
    };
  }

  if (state.permissionMode === "block") {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}, mode: block). Command: ${command}
Requires ${requiredInfo.label}. Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
Use /permission ${requiredLevel} or /permission-mode ask to enable prompts.`
    };
  }

  // Interactive mode: prompt
  playPermissionSound();
  const choice = await ctx.ui.select(
    `Requires ${requiredInfo.label}`,
    ["Allow once", `Allow all (${requiredInfo.label})`, "Cancel"]
  );

  if (choice === "Allow once") return undefined;

  if (choice === `Allow all (${requiredInfo.label})`) {
    setLevel(state, requiredLevel, true, ctx);
    ctx.ui.notify(`Permission → ${requiredInfo.label} (saved globally)`, "info");
    return undefined;
  }

  return { block: true, reason: "Cancelled" };
}

/** Options for handleWriteToolCall */
export interface WriteToolCallOptions {
  state: PermissionState;
  toolName: string;
  filePath: string;
  ctx: any;
}

/** Handle write/edit tool_call - check permission and prompt if needed */
export async function handleWriteToolCall(
  opts: WriteToolCallOptions
): Promise<{ block: true; reason: string } | undefined> {
  const { state, toolName, filePath, ctx } = opts;
  
  if (state.currentLevel === "bypassed") return undefined;

  if (LEVEL_INDEX[state.currentLevel] >= LEVEL_INDEX["low"]) return undefined;

  const action = toolName === "write" ? "Write" : "Edit";
  const message = `Requires Low: ${action} ${filePath}`;

  // Print mode: block
  if (!hasInteractiveUI(ctx)) {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}). ${action}: ${filePath}
Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
User can re-run with: PI_PERMISSION_LEVEL=low pi -p "..."`
    };
  }

  if (state.permissionMode === "block") {
    return {
      block: true,
      reason: `Blocked by permission (${state.currentLevel}, mode: block). ${action}: ${filePath}
Requires Low. Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}
Use /permission low or /permission-mode ask to enable prompts.`
    };
  }

  // Interactive mode: prompt
  playPermissionSound();
  const choice = await ctx.ui.select(
    message,
    ["Allow once", "Allow all (Low)", "Cancel"]
  );

  if (choice === "Allow once") return undefined;

  if (choice === "Allow all (Low)") {
    setLevel(state, "low", true, ctx);
    ctx.ui.notify(`Permission → Low (saved globally)`, "info");
    return undefined;
  }

  return { block: true, reason: "Cancelled" };
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  const state = createInitialState();

  pi.registerCommand("permission", {
    description: "View or change permission level",
    handler: (args, ctx) => handlePermissionCommand(state, args, ctx),
  });

  pi.registerCommand("permission-mode", {
    description: "Set permission prompt mode (ask or block)",
    handler: (args, ctx) => handlePermissionModeCommand(state, args, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    handleSessionStart(state, ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return handleBashToolCall(state, event.input.command as string, ctx);
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      return handleWriteToolCall({
        state,
        toolName: event.toolName,
        filePath: event.input.path as string,
        ctx,
      });
    }

    return undefined;
  });
}
