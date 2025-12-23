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
import type { SessionHeader } from "@mariozechner/pi-coding-agent";
import { exec, spawn } from "child_process";
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

// Low-priority git command using spawn (doesn't block shell)
function gitLowPriority(
  cmd: string,
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Parse command respecting quotes for arguments with spaces
    const args: string[] = [];
    let current = "";
    let inQuote = false;
    for (const char of cmd) {
      if (char === "'" || char === '"') {
        inQuote = !inQuote;
      } else if (char === " " && !inQuote) {
        if (current) args.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    if (current) args.push(current);
    
    const proc = spawn("git", args, { 
      cwd, 
      stdio: ["ignore", "pipe", "pipe"],
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });
    
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `git ${cmd} failed with code ${code}`));
      }
    });
    
    proc.on("error", reject);
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
  const root = await getRepoRoot(cwd);
  await git("clean -fd", root);
  if (cp.headSha !== ZEROS) {
    await git(`reset --hard ${cp.headSha}`, root);
  }
  await git(`read-tree --reset ${cp.worktreeTreeSha}`, root);
  await git("checkout-index -a -f", root);
  await git(`read-tree --reset ${cp.indexTreeSha}`, root);
}

async function loadCheckpointFromRef(
  cwd: string,
  refName: string,
  lowPriority = false,
): Promise<CheckpointData | null> {
  try {
    const root = await getRepoRoot(cwd);
    const gitFn = lowPriority ? gitLowPriority : git;
    const commitSha = await gitFn(
      `rev-parse --verify ${REF_BASE}/${refName}`,
      root,
    );
    const commitMsg = await gitFn(`cat-file commit ${commitSha}`, root);

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

async function listCheckpointRefs(cwd: string, lowPriority = false): Promise<string[]> {
  try {
    const root = await getRepoRoot(cwd);
    const prefix = `${REF_BASE}/`;
    const gitFn = lowPriority ? gitLowPriority : git;
    const stdout = await gitFn(
      `for-each-ref --format="%(refname)" ${prefix}`,
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
  lowPriority = false,
): Promise<CheckpointData[]> {
  const refs = await listCheckpointRefs(cwd, lowPriority);
  
  // For low priority loading, process in small batches with yields
  if (lowPriority) {
    const results: CheckpointData[] = [];
    const BATCH_SIZE = 3;
    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
      const batch = refs.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((ref) => loadCheckpointFromRef(cwd, ref, true)),
      );
      results.push(
        ...batchResults.filter(
          (cp): cp is CheckpointData =>
            cp !== null && (!sessionFilter || cp.sessionId === sessionFilter),
        ),
      );
      // Yield to event loop between batches
      await new Promise((resolve) => setImmediate(resolve));
    }
    return results;
  }
  
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
  // First try to read from file content (first line is session header)
  try {
    const content = await readFile(sessionFile, "utf-8");
    if (content.trim()) {
      const id = JSON.parse(content.split("\n")[0]).id || "";
      if (isSafeId(id)) return id;
    }
  } catch {
    // Fall through to filename extraction
  }

  // Fallback: extract session ID from filename (format: {timestamp}_{sessionId}.jsonl)
  const basename = sessionFile.split("/").pop() || "";
  const match = basename.match(/_([0-9a-f-]{36})\.jsonl$/);
  if (match && isSafeId(match[1])) {
    return match[1];
  }

  return "";
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

  // Cache for checkpoints - avoids re-fetching on every branch click
  let checkpointCache: CheckpointData[] | null = null;
  let cacheSessionIds: Set<string> = new Set();

  pi.on("session", async (event, ctx) => {
    switch (event.reason) {
      case "start": {
        gitAvailable = await isGitRepo(ctx.cwd);
        if (!gitAvailable || !ctx.sessionFile) return;

        currentSessionFile = ctx.sessionFile;
        // Get session ID from event.entries (no file read needed)
        const startHeader = event.entries.find((e) => e.type === "session") as SessionHeader | undefined;
        currentSessionId = startHeader?.id && isSafeId(startHeader.id) ? startHeader.id : "";

        // Defer checkpoint loading to not block initial rendering
        // Use setImmediate to let the event loop process UI first
        setImmediate(() => {
          // Use low-priority loading with batching and yields
          loadAllCheckpoints(ctx.cwd, undefined, true)
            .then((cps) => {
              checkpointCache = cps;
              cacheSessionIds = new Set(cps.map((cp) => cp.sessionId));
            })
            .catch(() => {});
        });
        return;
      }

      case "switch": {
        if (!gitAvailable || !ctx.sessionFile) return;
        // Get session ID from event.entries (no file read needed)
        const switchHeader = event.entries.find((e) => e.type === "session") as SessionHeader | undefined;
        currentSessionId = switchHeader?.id && isSafeId(switchHeader.id) ? switchHeader.id : "";
        return;
      }

      case "before_branch": {
        // Handle checkpoint restoration when branching
        if (!gitAvailable) return undefined;

        // Show menu immediately while loading checkpoints in parallel
        type Choice = "all" | "conv" | "code" | "cancel";
        const options: { label: string; value: Choice }[] = [
          { label: "Restore all (files + conversation)", value: "all" },
          { label: "Conversation only (keep current files)", value: "conv" },
          { label: "Code only (restore files, keep conversation)", value: "code" },
          { label: "Cancel", value: "cancel" },
        ];

        // Start checkpoint loading in background while showing menu
        const checkpointLoadPromise = (async () => {
          // Wait for any in-flight checkpoint
          if (pendingCheckpoint) await pendingCheckpoint;

          // Collect session IDs from the branch chain using event.entries
          const sessionIds: string[] = [];
          const header = event.entries.find((e) => e.type === "session") as SessionHeader | undefined;

          if (header?.id && isSafeId(header.id)) {
            sessionIds.push(header.id);
          }

          // Extract session IDs from all session files in directory
          if (header?.branchedFrom) {
            const sessionDir = header.branchedFrom.substring(
              0,
              header.branchedFrom.lastIndexOf("/"),
            );
            try {
              // Read session IDs from file content (first line JSON)
              const { stdout } = await new Promise<{ stdout: string }>(
                (resolve) => {
                  exec(
                    `for f in "${sessionDir}"/*.jsonl; do head -1 "$f" 2>/dev/null | grep -o '"id":"[^"]*"' | cut -d'"' -f4; done | sort -u`,
                    { maxBuffer: 1024 * 1024 },
                    (err, stdout) => resolve({ stdout: stdout || "" }),
                  );
                },
              );
              stdout
                .split("\n")
                .filter(Boolean)
                .forEach((id) => {
                  if (isSafeId(id) && !sessionIds.includes(id)) {
                    sessionIds.push(id);
                  }
                });
            } catch {
              // Ignore grep errors
            }
          }

          // Use cache if available and contains all needed sessions
          const needsRefresh = sessionIds.some((id) => !cacheSessionIds.has(id));

          if (checkpointCache && !needsRefresh) {
            if (!header?.branchedFrom) return checkpointCache;
            const sessionSet = new Set(sessionIds);
            return checkpointCache.filter((cp) => sessionSet.has(cp.sessionId));
          }

          // Load fresh checkpoints (filter by session if we have IDs, else load all)
          const allCheckpoints = await loadAllCheckpoints(ctx.cwd);
          checkpointCache = allCheckpoints;
          cacheSessionIds = new Set(allCheckpoints.map((cp) => cp.sessionId));

          const sessionSet = new Set(sessionIds);
          return header?.branchedFrom
            ? allCheckpoints.filter((cp) => sessionSet.has(cp.sessionId))
            : allCheckpoints;
        })();

        // Show menu immediately - don't wait for checkpoint loading
        const choice = await ctx.ui.select(
          "Restore code state?",
          options.map((o) => o.label),
        );

        const selected = options.find((o) => o.label === choice)?.value ?? "cancel";

        if (selected === "cancel") {
          return { cancel: true };
        }
        // "conv" - let default branch behavior restore conversation, don't touch files
        if (selected === "conv") {
          return undefined;
        }

        // Now we need checkpoints - wait for loading to complete
        const checkpoints = await checkpointLoadPromise;

        if (checkpoints.length === 0) {
          ctx.ui.notify("No checkpoints available", "warning");
          return selected === "code" ? { skipConversationRestore: true } : undefined;
        }

        // Get target entry timestamp and find checkpoint with closest matching timestamp
        const targetEntry = event.entries[event.targetTurnIndex];
        const targetTs =
          targetEntry && "timestamp" in targetEntry
            ? new Date(targetEntry.timestamp).getTime()
            : Date.now();

        // Find checkpoint with timestamp closest to target (prefer slightly before)
        const checkpoint = checkpoints.reduce((best, cp) => {
          const bestDiff = Math.abs(best.timestamp - targetTs);
          const cpDiff = Math.abs(cp.timestamp - targetTs);
          // Prefer checkpoint that's before or equal to target
          if (cp.timestamp <= targetTs && best.timestamp > targetTs) return cp;
          if (best.timestamp <= targetTs && cp.timestamp > targetTs) return best;
          return cpDiff < bestDiff ? cp : best;
        });

        const saveAndRestore = async (target: CheckpointData) => {
          try {
            const beforeId = `${currentSessionId}-before-restore-${Date.now()}`;
            const newCp = await createCheckpoint(
              ctx.cwd,
              beforeId,
              event.targetTurnIndex,
              currentSessionId,
            );
            // Update cache
            if (checkpointCache) {
              checkpointCache.push(newCp);
              cacheSessionIds.add(newCp.sessionId);
            }
            await restoreCheckpoint(ctx.cwd, target);
            ctx.ui.notify("Files restored to checkpoint", "info");
          } catch (error) {
            ctx.ui.notify(
              `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
        };

        if (selected === "code") {
          await saveAndRestore(checkpoint);
          return { skipConversationRestore: true };
        }

        // "all" - restore files and let conversation restore happen
        await saveAndRestore(checkpoint);
        return undefined;
      }
    }
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
        const cp = await createCheckpoint(ctx.cwd, id, event.turnIndex, currentSessionId);
        // Update cache with new checkpoint
        if (checkpointCache) {
          checkpointCache.push(cp);
          cacheSessionIds.add(cp.sessionId);
        }
      } catch {
        checkpointingFailed = true;
      }
    })();
  });
}
