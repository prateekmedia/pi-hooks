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
import { numberedSelect } from "../ui.js";
import {
  isGitRepo,
  getRepoRoot,
  createCheckpoint,
  restoreCheckpoint,
  listCheckpointRefs,
  loadCheckpointFromRef,
  isSafeId,
  type CheckpointData,
} from "./checkpoint-core.js";

// ============================================================================
// Minimal local types (avoid hard dependency on pi-coding-agent types)
// ============================================================================

type ExtensionAPI = {
  on: (event: string, handler: (event: any, ctx: ExtensionContext) => any) => void;
};

interface SessionManager {
  getSessionFile(): string | undefined;
  getHeader(): { id?: string; parentSession?: string } | undefined;
  getEntry(id: string): {
    timestamp?: string;
    turnIndex?: number;
    turn?: number;
    sessionId?: string;
    role?: string;
    type?: string;
    kind?: string;
    author?: string;
    message?: { role?: string };
  } | undefined;
}

interface ExtensionUI {
  select(title: string, options: string[]): Promise<string>;
  notify(message: string, type: "info" | "error" | "warning"): void;
}

interface ExtensionContext {
  cwd: string;
  sessionManager: SessionManager;
  ui: ExtensionUI;
}

// ============================================================================
// State management
// ============================================================================

interface CheckpointState {
  gitAvailable: boolean;
  checkpointingFailed: boolean;
  currentSessionId: string;
  currentSessionFile: string | undefined;
  checkpointCache: CheckpointData[] | null;
  pendingCheckpoint: Promise<void> | null;
}

function createInitialState(): CheckpointState {
  return {
    gitAvailable: false,
    checkpointingFailed: false,
    currentSessionId: "",
    currentSessionFile: undefined,
    checkpointCache: null,
    pendingCheckpoint: null,
  };
}

/** Add checkpoint to cache */
function addToCache(state: CheckpointState, cp: CheckpointData): void {
  if (!state.checkpointCache) {
    state.checkpointCache = [];
  }
  if (state.checkpointCache.some((existing) => existing.id === cp.id)) return;
  state.checkpointCache.push(cp);
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

interface CheckpointRefInfo {
  id: string;
  timestamp: number;
}

function getCachedCheckpointById(
  state: CheckpointState,
  id: string
): CheckpointData | undefined {
  return state.checkpointCache?.find((cp) => cp.id === id);
}

function parseCheckpointTimestampFromId(id: string): number | undefined {
  const lastDash = id.lastIndexOf("-");
  if (lastDash === -1 || lastDash === id.length - 1) return undefined;
  const raw = id.slice(lastDash + 1);
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : undefined;
}

function findClosestCheckpointRef(
  refs: CheckpointRefInfo[],
  targetTs: number
): CheckpointRefInfo | undefined {
  if (refs.length === 0) return undefined;
  return refs.reduce((best, ref) => {
    const bestDiff = Math.abs(best.timestamp - targetTs);
    const refDiff = Math.abs(ref.timestamp - targetTs);
    if (ref.timestamp <= targetTs && best.timestamp > targetTs) return ref;
    if (best.timestamp <= targetTs && ref.timestamp > targetTs) return best;
    return refDiff < bestDiff ? ref : best;
  });
}

function isUserEntry(entry: any): boolean | undefined {
  if (!entry) return undefined;
  const messageRole = entry.message?.role;
  if (typeof messageRole === "string") return messageRole === "user";
  const role = entry.role ?? entry.kind ?? entry.author;
  if (typeof role === "string") return role === "user";
  return undefined;
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
function updateSessionInfo(state: CheckpointState, sessionManager: SessionManager): void {
  state.currentSessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  state.currentSessionId = header?.id && isSafeId(header.id) ? header.id : "";
}

// ============================================================================
// Checkpoint operations
// ============================================================================

/** Load the best matching checkpoint for a target timestamp */
async function loadCheckpointForTarget(
  state: CheckpointState,
  cwd: string,
  header: { id?: string; parentSession?: string } | undefined,
  targetTs: number,
  options: { targetTurnIndex?: number; targetSessionId?: string } = {}
): Promise<CheckpointData | null> {
  if (state.pendingCheckpoint) await state.pendingCheckpoint;

  const sessionIds: string[] = [];
  const directSessionIds: string[] = [];

  const targetSessionId =
    options.targetSessionId && isSafeId(options.targetSessionId)
      ? options.targetSessionId
      : undefined;

  if (targetSessionId) {
    directSessionIds.push(targetSessionId);
  } else if (header?.id && isSafeId(header.id)) {
    directSessionIds.push(header.id);
  } else if (state.currentSessionId) {
    directSessionIds.push(state.currentSessionId);
  }

  directSessionIds.forEach((id) => sessionIds.push(id));
  if (header?.id && isSafeId(header.id) && !sessionIds.includes(header.id)) {
    sessionIds.push(header.id);
  }

  // Walk the parentSession chain (fork lineage)
  const visitedParents = new Set<string>();
  const MAX_PARENT_DEPTH = 50;
  let parentSession = header?.parentSession;
  let depth = 0;

  while (parentSession && depth < MAX_PARENT_DEPTH) {
    if (visitedParents.has(parentSession)) break;
    visitedParents.add(parentSession);
    depth++;

    const match = parentSession.match(/_([0-9a-f-]{36})\.jsonl$/);
    if (match && isSafeId(match[1]) && !sessionIds.includes(match[1])) {
      sessionIds.push(match[1]);
    }
    try {
      const line = await readFirstLine(parentSession);
      const next = line ? extractJsonField(line, "parentSession") : undefined;
      parentSession = next && next !== parentSession ? next : undefined;
    } catch {
      break;
    }
  }

  if (sessionIds.length === 0) return null;

  const root = await getCachedRepoRoot(cwd);

  if (
    typeof options.targetTurnIndex === "number" &&
    Number.isFinite(options.targetTurnIndex) &&
    directSessionIds.length > 0
  ) {
    for (const sessionId of directSessionIds) {
      const candidateId = `${sessionId}-turn-${options.targetTurnIndex}-${targetTs}`;
      const cached = getCachedCheckpointById(state, candidateId);
      if (cached) return cached;

      const direct = await loadCheckpointFromRef(root, candidateId, true);
      if (direct) {
        addToCache(state, direct);
        return direct;
      }
    }
  }

  const refs = await listCheckpointRefs(root, true);
  if (refs.length === 0) return null;

  const refInfos: CheckpointRefInfo[] = [];
  for (const ref of refs) {
    const matchesSession = sessionIds.some((id) => ref.startsWith(`${id}-`));
    if (!matchesSession) continue;
    const timestamp = parseCheckpointTimestampFromId(ref);
    if (timestamp === undefined) continue;
    refInfos.push({ id: ref, timestamp });
  }

  if (refInfos.length === 0) return null;

  const exactRef = refInfos.find((ref) => ref.timestamp === targetTs);
  const bestRef = exactRef ?? findClosestCheckpointRef(refInfos, targetTs);
  if (!bestRef) return null;

  const cached = getCachedCheckpointById(state, bestRef.id);
  if (cached) return cached;

  const checkpoint = await loadCheckpointFromRef(root, bestRef.id, true);
  if (checkpoint) addToCache(state, checkpoint);
  return checkpoint ?? null;
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
  ctx: ExtensionContext,
  getTargetEntryId: () => string,
  options: { codeOnly: "cancel" | "skipConversationRestore"; requireUserEntry?: boolean }
): Promise<{ cancel: true } | { skipConversationRestore: true } | undefined> {
  const targetEntry = ctx.sessionManager.getEntry(getTargetEntryId());

  if (options.requireUserEntry) {
    const isUser = isUserEntry(targetEntry);
    if (isUser !== true) {
      ctx.ui.notify(
        "Code restore is only available for user messages. Skipping code restore.",
        "warning"
      );
      return undefined;
    }
  }

  const targetTs = targetEntry?.timestamp
    ? new Date(targetEntry.timestamp).getTime()
    : Date.now();

  const choice = await numberedSelect(ctx,
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

  const targetTurnIndex = targetEntry?.turnIndex ?? targetEntry?.turn;
  const targetSessionId = targetEntry?.sessionId;
  const exactTurnIndex = targetEntry?.timestamp ? targetTurnIndex : undefined;

  const checkpoint = await loadCheckpointForTarget(
    state,
    ctx.cwd,
    ctx.sessionManager.getHeader(),
    targetTs,
    {
      targetTurnIndex: exactTurnIndex,
      targetSessionId,
    }
  );

  if (!checkpoint) {
    ctx.ui.notify("No checkpoints available", "warning");
    return selected === "code" ? { cancel: true } : undefined;
  }

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

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    resetRepoCache();

    state.gitAvailable = await isGitRepo(ctx.cwd);
    if (!state.gitAvailable) return;

    updateSessionInfo(state, ctx.sessionManager);

  });

  pi.on("session_switch", async (_event: any, ctx: ExtensionContext) => {
    if (!state.gitAvailable) return;
    updateSessionInfo(state, ctx.sessionManager);
  });

  pi.on("session_fork", async (_event: any, ctx: ExtensionContext) => {
    if (!state.gitAvailable) return;
    updateSessionInfo(state, ctx.sessionManager);
  });

  pi.on("session_before_fork", async (event: any, ctx: ExtensionContext) => {
    if (!state.gitAvailable) return undefined;
    return handleRestorePrompt(state, ctx, () => event.entryId, {
      codeOnly: "skipConversationRestore",
    });
  });

  pi.on("session_before_tree", async (event: any, ctx: ExtensionContext) => {
    if (!state.gitAvailable) return undefined;
    return handleRestorePrompt(state, ctx, () => event.preparation.targetId, {
      codeOnly: "cancel",
      requireUserEntry: true,
    });
  });

  pi.on("turn_start", async (event: any, ctx: ExtensionContext) => {
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
