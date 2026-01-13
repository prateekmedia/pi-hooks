/**
 * Git-based checkpoint extension for pi-coding-agent
 *
 * Creates checkpoints at the start of each turn so you can restore
 * code state when forking conversations.
 *
 * Features:
 * - Captures tracked, staged, AND untracked files (respects .gitignore)
 * - Persists checkpoints as git refs (survives session resume)
 * - Saves current state before restore (allows going back to latest)
 *
 * Usage:
 *   pi --extension ./checkpoint.ts
 *
 * Or add to ~/.pi/agent/extensions/ or .pi/extensions/ for automatic loading.
 */

import { spawn } from "child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  isGitRepo,
  getRepoRoot,
  createCheckpoint,
  restoreCheckpoint,
  loadAllCheckpoints,
  findClosestCheckpoint,
  isSafeId,
  type CheckpointData,
} from "./checkpoint-core.js";

// ============================================================================
// State management
// ============================================================================

interface CheckpointState {
  gitAvailable: boolean;
  checkpointingFailed: boolean;
  currentSessionId: string;
  currentSessionFile: string | undefined;
  checkpointCache: CheckpointData[] | null;
  cacheSessionIds: Set<string>;
  pendingCheckpoint: Promise<void> | null;
}

function createInitialState(): CheckpointState {
  return {
    gitAvailable: false,
    checkpointingFailed: false,
    currentSessionId: "",
    currentSessionFile: undefined,
    checkpointCache: null,
    cacheSessionIds: new Set(),
    pendingCheckpoint: null,
  };
}

/** Add checkpoint to cache */
function addToCache(state: CheckpointState, cp: CheckpointData): void {
  if (state.checkpointCache) {
    state.checkpointCache.push(cp);
    state.cacheSessionIds.add(cp.sessionId);
  }
}

/** Replace entire cache */
function setCache(state: CheckpointState, cps: CheckpointData[]): void {
  state.checkpointCache = cps;
  state.cacheSessionIds = new Set(cps.map((cp) => cp.sessionId));
}

// Repo root cache (module-level for efficiency across sessions)
let cachedRepoRoot: string | null = null;
let cachedRepoCwd: string | null = null;

async function getCachedRepoRoot(cwd: string): Promise<string> {
  if (cachedRepoCwd !== cwd) {
    cachedRepoRoot = null;
    cachedRepoCwd = cwd;
  }
  if (!cachedRepoRoot) {
    cachedRepoRoot = await getRepoRoot(cwd);
  }
  return cachedRepoRoot;
}

function resetRepoCache(): void {
  cachedRepoRoot = null;
  cachedRepoCwd = null;
}

/** Read first line of a file using head (efficient, doesn't load entire file) */
function readFirstLine(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("head", ["-1", filePath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let data = "";
    proc.stdout.on("data", (chunk) => (data += chunk));
    proc.on("close", () => resolve(data.trim()));
    proc.on("error", () => resolve(""));
  });
}

/** Extract a JSON field from a line using regex (avoids JSON.parse overhead) */
function extractJsonField(line: string, field: string): string | undefined {
  const regex = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, "i");
  const match = line.match(regex);
  return match?.[1] || undefined;
}

// ============================================================================
// Session helpers
// ============================================================================

/** Extract session ID from a session file */
async function getSessionIdFromFile(sessionFile: string): Promise<string> {
  try {
    const line = await readFirstLine(sessionFile);
    if (line) {
      const id = extractJsonField(line, "id") || "";
      if (isSafeId(id)) return id;
    }
  } catch {}

  const basename = sessionFile.split("/").pop() || "";
  const match = basename.match(/_([0-9a-f-]{36})\.jsonl$/);
  if (match && isSafeId(match[1])) {
    return match[1];
  }

  return "";
}

/** Update session info from context */
function updateSessionInfo(state: CheckpointState, sessionManager: any): void {
  state.currentSessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  state.currentSessionId = header?.id && isSafeId(header.id) ? header.id : "";
}

// ============================================================================
// Checkpoint operations
// ============================================================================

/** Load checkpoints for session chain (current + ancestors) */
async function loadSessionChainCheckpoints(
  state: CheckpointState,
  cwd: string,
  header: { id?: string; parentSession?: string } | undefined
): Promise<CheckpointData[]> {
  if (state.pendingCheckpoint) await state.pendingCheckpoint;

  const sessionIds: string[] = [];

  if (header?.id && isSafeId(header.id)) {
    sessionIds.push(header.id);
  } else if (state.currentSessionId) {
    sessionIds.push(state.currentSessionId);
  }

  // Walk the parentSession chain (fork lineage)
  let parentSession = header?.parentSession;
  while (parentSession) {
    const match = parentSession.match(/_([0-9a-f-]{36})\.jsonl$/);
    if (match && isSafeId(match[1]) && !sessionIds.includes(match[1])) {
      sessionIds.push(match[1]);
    }
    try {
      const line = await readFirstLine(parentSession);
      parentSession = line ? extractJsonField(line, "parentSession") : undefined;
    } catch {
      break;
    }
  }

  if (sessionIds.length === 0) return [];

  const needsRefresh = sessionIds.some((id) => !state.cacheSessionIds.has(id));
  const root = await getCachedRepoRoot(cwd);

  if (state.checkpointCache && !needsRefresh) {
    const sessionSet = new Set(sessionIds);
    return state.checkpointCache.filter((cp) => sessionSet.has(cp.sessionId));
  }

  const allCheckpoints = await loadAllCheckpoints(root);
  setCache(state, allCheckpoints);

  const sessionSet = new Set(sessionIds);
  return allCheckpoints.filter((cp) => sessionSet.has(cp.sessionId));
}

/** Save current state and restore to checkpoint */
async function saveAndRestore(
  state: CheckpointState,
  cwd: string,
  target: CheckpointData,
  notify: (msg: string, type: "info" | "error" | "warning") => void
): Promise<void> {
  try {
    const root = await getCachedRepoRoot(cwd);
    const beforeId = `${state.currentSessionId}-before-restore-${Date.now()}`;
    const newCp = await createCheckpoint(root, beforeId, 0, state.currentSessionId);
    addToCache(state, newCp);
    await restoreCheckpoint(root, target);
    notify("Files restored to checkpoint", "info");
  } catch (error) {
    notify(
      `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
  }
}

/** Create a checkpoint for the current turn */
async function createTurnCheckpoint(
  state: CheckpointState,
  cwd: string,
  turnIndex: number,
  timestamp: number
): Promise<void> {
  const root = await getCachedRepoRoot(cwd);
  const id = `${state.currentSessionId}-turn-${turnIndex}-${timestamp}`;
  const cp = await createCheckpoint(root, id, turnIndex, state.currentSessionId);
  addToCache(state, cp);
}

/** Preload checkpoints in background */
async function preloadCheckpoints(state: CheckpointState, cwd: string): Promise<void> {
  const root = await getCachedRepoRoot(cwd);
  const cps = await loadAllCheckpoints(root, undefined, true);
  setCache(state, cps);
}

// ============================================================================
// Restore UI
// ============================================================================

type RestoreChoice = "all" | "conv" | "code" | "cancel";

const restoreOptions: { label: string; value: RestoreChoice }[] = [
  { label: "Restore all (files + conversation)", value: "all" },
  { label: "Conversation only (keep current files)", value: "conv" },
  { label: "Code only (restore files, keep conversation)", value: "code" },
  { label: "Cancel", value: "cancel" },
];

/** Handle restore prompt for fork/tree navigation */
async function handleRestorePrompt(
  state: CheckpointState,
  ctx: any,
  getTargetEntryId: () => string,
  options: { codeOnly: "cancel" | "skipConversationRestore" }
): Promise<{ cancel: true } | { skipConversationRestore: true } | undefined> {
  const checkpointLoadPromise = loadSessionChainCheckpoints(
    state,
    ctx.cwd,
    ctx.sessionManager.getHeader()
  );

  const choice = await ctx.ui.select(
    "Restore code state?",
    restoreOptions.map((o) => o.label)
  );

  const selected = restoreOptions.find((o) => o.label === choice)?.value ?? "cancel";

  if (selected === "cancel") {
    return { cancel: true };
  }
  if (selected === "conv") {
    return undefined;
  }

  const checkpoints = await checkpointLoadPromise;

  if (checkpoints.length === 0) {
    ctx.ui.notify("No checkpoints available", "warning");
    return selected === "code" ? { cancel: true } : undefined;
  }

  const targetEntry = ctx.sessionManager.getEntry(getTargetEntryId());
  const targetTs = targetEntry?.timestamp
    ? new Date(targetEntry.timestamp).getTime()
    : Date.now();

  const checkpoint = findClosestCheckpoint(checkpoints, targetTs);

  await saveAndRestore(state, ctx.cwd, checkpoint, ctx.ui.notify.bind(ctx.ui));

  if (selected !== "code") return undefined;

  return options.codeOnly === "skipConversationRestore"
    ? { skipConversationRestore: true }
    : { cancel: true };
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  const state = createInitialState();

  pi.on("session_start", async (_event, ctx) => {
    resetRepoCache();

    state.gitAvailable = await isGitRepo(ctx.cwd);
    if (!state.gitAvailable) return;

    updateSessionInfo(state, ctx.sessionManager);

    setImmediate(async () => {
      try {
        await preloadCheckpoints(state, ctx.cwd);
      } catch { }
    });
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (!state.gitAvailable) return;
    updateSessionInfo(state, ctx.sessionManager);
  });

  pi.on("session_fork", async (_event, ctx) => {
    if (!state.gitAvailable) return;
    updateSessionInfo(state, ctx.sessionManager);
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (!state.gitAvailable) return undefined;
    return handleRestorePrompt(state, ctx, () => event.entryId, {
      codeOnly: "skipConversationRestore",
    });
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!state.gitAvailable) return undefined;
    return handleRestorePrompt(state, ctx, () => event.preparation.targetId, {
      codeOnly: "cancel",
    });
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!state.gitAvailable || state.checkpointingFailed) return;

    if (!state.currentSessionId && state.currentSessionFile) {
      state.currentSessionId = await getSessionIdFromFile(state.currentSessionFile);
    }
    if (!state.currentSessionId) return;

    state.pendingCheckpoint = (async () => {
      try {
        await createTurnCheckpoint(state, ctx.cwd, event.turnIndex, event.timestamp);
      } catch {
        state.checkpointingFailed = true;
      }
    })();
  });
}
