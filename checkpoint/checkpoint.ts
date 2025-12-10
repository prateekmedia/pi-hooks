/**
 * Git-based checkpoint hook for pi-coding-agent
 *
 * Creates checkpoints at the start of each turn so you can restore
 * code state when branching conversations.
 *
 * Features:
 * - Captures tracked, staged, AND untracked files (respects .gitignore)
 * - Persists checkpoints as git refs (survives session resume)
 * - Saves current state before restore (allows going back to latest)
 *
 * Usage:
 *   pi --hook ./checkpoint.ts
 *
 * Or add to ~/.pi/agent/hooks/ or .pi/hooks/ for automatic loading.
 */

import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";
import { exec } from "child_process";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================================
// Constants & Types
// ============================================================================

const ZEROS = "0".repeat(40);
const REF_BASE = "refs/pi-checkpoints";

interface CheckpointData {
  id: string;
  turnIndex: number;
  sessionId: string;
  headSha: string;
  indexTreeSha: string;
  worktreeTreeSha: string;
  timestamp: number;
}

// ============================================================================
// Git helpers
// ============================================================================

function git(
  cmd: string,
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = exec(
      `git ${cmd}`,
      { cwd, env: opts.env, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    if (opts.input && proc.stdin) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    }
  });
}

const isGitRepo = (cwd: string) =>
  git("rev-parse --is-inside-work-tree", cwd)
    .then(() => true)
    .catch(() => false);

let cachedRepoRoot: string | null = null;
const getRepoRoot = async (cwd: string) => {
  if (!cachedRepoRoot) {
    cachedRepoRoot = await git("rev-parse --show-toplevel", cwd);
  }
  return cachedRepoRoot;
};

// ============================================================================
// Checkpoint operations
// ============================================================================

async function createCheckpoint(
  cwd: string,
  id: string,
  turnIndex: number,
  sessionId: string,
): Promise<CheckpointData> {
  const root = await getRepoRoot(cwd);
  const timestamp = Date.now();
  const isoTimestamp = new Date(timestamp).toISOString();

  // Get HEAD (handle unborn)
  const headSha = await git("rev-parse HEAD", root).catch(() => ZEROS);

  // Capture index (staged changes)
  const indexTreeSha = await git("write-tree", root);

  // Capture worktree (ALL files including untracked) via temp index
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
  const tmpIndex = join(tmpDir, "index");

  try {
    const tmpEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    await git("add -A .", root, { env: tmpEnv });
    const worktreeTreeSha = await git("write-tree", root, { env: tmpEnv });

    // Create checkpoint commit with metadata
    const message = [
      `checkpoint:${id}`,
      `sessionId ${sessionId}`,
      `turn ${turnIndex}`,
      `head ${headSha}`,
      `index-tree ${indexTreeSha}`,
      `worktree-tree ${worktreeTreeSha}`,
      `created ${isoTimestamp}`,
    ].join("\n");

    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "pi-checkpoint",
      GIT_AUTHOR_EMAIL: "checkpoint@pi",
      GIT_AUTHOR_DATE: isoTimestamp,
      GIT_COMMITTER_NAME: "pi-checkpoint",
      GIT_COMMITTER_EMAIL: "checkpoint@pi",
      GIT_COMMITTER_DATE: isoTimestamp,
    };

    const commitSha = await git(`commit-tree ${worktreeTreeSha}`, root, {
      input: message,
      env: commitEnv,
    });

    // Store as git ref
    await git(`update-ref ${REF_BASE}/${id} ${commitSha}`, root);

    return {
      id,
      turnIndex,
      sessionId,
      headSha,
      indexTreeSha,
      worktreeTreeSha,
      timestamp,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function restoreCheckpoint(
  cwd: string,
  cp: CheckpointData,
): Promise<void> {
  if (cp.headSha === ZEROS) {
    throw new Error("Cannot restore: checkpoint was saved with no commits");
  }

  const root = await getRepoRoot(cwd);
  // Clean untracked files first (respects .gitignore)
  await git("clean -fd", root);
  await git(`reset --hard ${cp.headSha}`, root);
  await git(`read-tree --reset ${cp.worktreeTreeSha}`, root);
  await git("checkout-index -a -f", root);
  await git(`read-tree --reset ${cp.indexTreeSha}`, root);
}

async function loadCheckpointFromRef(
  cwd: string,
  refName: string,
): Promise<CheckpointData | null> {
  try {
    const root = await getRepoRoot(cwd);
    const commitSha = await git(
      `rev-parse --verify ${REF_BASE}/${refName}`,
      root,
    );
    const commitMsg = await git(`cat-file commit ${commitSha}`, root);

    const get = (key: string) =>
      commitMsg.match(new RegExp(`^${key} (.+)$`, "m"))?.[1]?.trim();

    const sessionId = get("sessionId");
    const turn = get("turn");
    const head = get("head");
    const index = get("index-tree");
    const worktree = get("worktree-tree");
    const created = get("created");

    if (!sessionId || !turn || !head || !index || !worktree) return null;

    return {
      id: refName,
      turnIndex: parseInt(turn, 10),
      sessionId,
      headSha: head,
      indexTreeSha: index,
      worktreeTreeSha: worktree,
      timestamp: created ? new Date(created).getTime() : 0,
    };
  } catch {
    return null;
  }
}

async function listCheckpointRefs(cwd: string): Promise<string[]> {
  try {
    const root = await getRepoRoot(cwd);
    const prefix = `${REF_BASE}/`;
    const stdout = await git(
      `for-each-ref --format='%(refname)' ${prefix}`,
      root,
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((ref) => ref.replace(prefix, ""));
  } catch {
    return [];
  }
}

async function loadAllCheckpoints(
  cwd: string,
  sessionFilter?: string,
): Promise<CheckpointData[]> {
  const refs = await listCheckpointRefs(cwd);
  const results = await Promise.all(
    refs.map((ref) => loadCheckpointFromRef(cwd, ref)),
  );
  return results.filter(
    (cp): cp is CheckpointData =>
      cp !== null && (!sessionFilter || cp.sessionId === sessionFilter),
  );
}

// Validate ID contains only safe characters (alphanumeric, dash, underscore)
const isSafeId = (id: string) => /^[\w-]+$/.test(id);

async function getSessionIdFromFile(sessionFile: string): Promise<string> {
  try {
    const content = await readFile(sessionFile, "utf-8");
    const id = JSON.parse(content.split("\n")[0]).id || "";
    return isSafeId(id) ? id : "";
  } catch {
    return "";
  }
}

// ============================================================================
// Hook implementation
// ============================================================================

export default function (pi: HookAPI) {
  let pendingCheckpoint: Promise<void> | null = null;
  let gitAvailable = false;
  let checkpointingFailed = false;
  let currentSessionId = "";
  let currentSessionFile = "";

  pi.on("session_start", async (event, ctx) => {
    gitAvailable = await isGitRepo(ctx.cwd);
    if (!gitAvailable || !ctx.sessionFile) return;

    currentSessionFile = ctx.sessionFile;
    currentSessionId = await getSessionIdFromFile(ctx.sessionFile);
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!gitAvailable || checkpointingFailed) return;

    if (!currentSessionId && currentSessionFile) {
      currentSessionId = await getSessionIdFromFile(currentSessionFile);
    }
    if (!currentSessionId) return;

    // Fire and forget - but track promise so branch can wait
    pendingCheckpoint = (async () => {
      try {
        const id = `${currentSessionId}-turn-${event.turnIndex}-${event.timestamp}`;
        await createCheckpoint(ctx.cwd, id, event.turnIndex, currentSessionId);
      } catch {
        checkpointingFailed = true;
      }
    })();
  });

  pi.on("branch", async (event, ctx) => {
    if (!gitAvailable) return undefined;

    // Wait for any in-flight checkpoint before loading
    if (pendingCheckpoint) await pendingCheckpoint;

    const checkpoints = await loadAllCheckpoints(ctx.cwd, currentSessionId);

    if (checkpoints.length === 0) {
      ctx.ui.notify("No checkpoints available for this session", "warning");
      return undefined;
    }

    // Calculate the turn number from entry index
    // Turn N corresponds to the Nth user message (0-indexed)
    // event.targetTurnIndex is an entry index, not a turn number
    let targetTurn = 0;
    for (let i = 0; i < event.targetTurnIndex; i++) {
      const entry = event.entries[i];
      if (entry && "message" in entry && entry.message?.role === "user") {
        targetTurn++;
      }
    }

    // Find checkpoint with matching turn number
    const checkpoint = checkpoints.find((cp) => cp.turnIndex === targetTurn);

    if (!checkpoint) {
      ctx.ui.notify(`No checkpoint found for turn ${targetTurn}`, "warning");
      return undefined;
    }

    // Build menu options
    type Choice = "all" | "conv" | "code" | "oldest" | "cancel";
    const options: { label: string; value: Choice }[] = [
      { label: "Restore all (files + conversation)", value: "all" },
      { label: "Conversation only (keep current files)", value: "conv" },
      { label: "Code only (restore files, keep conversation)", value: "code" },
    ];
    if (checkpoints.length > 1) {
      options.push({
        label: "Restore oldest checkpoint (keep conversation)",
        value: "oldest",
      });
    }
    options.push({ label: "Cancel", value: "cancel" });

    const choice = await ctx.ui.select(
      "Restore code state?",
      options.map((o) => o.label),
    );

    const selected = options.find((o) => o.label === choice)?.value ?? "cancel";

    if (selected === "cancel") {
      return { skipConversationRestore: true };
    }
    // "conv" - let default branch behavior restore conversation, don't touch files
    if (selected === "conv") {
      return undefined;
    }

    const saveAndRestore = async (target: CheckpointData) => {
      try {
        const beforeId = `${currentSessionId}-before-restore-${Date.now()}`;
        checkpoints.push(
          await createCheckpoint(
            ctx.cwd,
            beforeId,
            event.targetTurnIndex,
            currentSessionId,
          ),
        );
        await restoreCheckpoint(ctx.cwd, target);
        ctx.ui.notify("Files restored to checkpoint", "info");
      } catch (error) {
        ctx.ui.notify(
          `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    };

    if (selected === "oldest") {
      // Find oldest checkpoint by timestamp
      const oldest = checkpoints.reduce((a, b) =>
        a.timestamp < b.timestamp ? a : b,
      );
      await saveAndRestore(oldest);
      return { skipConversationRestore: true };
    }

    if (selected === "code") {
      await saveAndRestore(checkpoint);
      return { skipConversationRestore: true };
    }

    // "all" - restore files and let conversation restore happen
    await saveAndRestore(checkpoint);
    return undefined;
  });

  pi.on("session_switch", async (event, ctx) => {
    if (!gitAvailable) return;
    if (event.reason === "branch") {
      currentSessionId = await getSessionIdFromFile(event.newSessionFile);
    }
  });
}
