/**
 * Git-based checkpoint hook for pi-coding-agent
 *
 * Creates checkpoints at the start of each turn so you can restore
 * code state when branching conversations.
 *
 * Usage:
 *   pi --hook ./checkpoint.ts
 *
 * Or add to ~/.pi/agent/hooks/ or .pi/hooks/ for automatic loading.
 */

import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";
import { exec } from "child_process";

// ============================================================================
// Async git helpers
// ============================================================================

function execAsync(
  command: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = exec(
      command,
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
    if (options.input && proc.stdin) {
      proc.stdin.write(options.input);
      proc.stdin.end();
    }
  });
}

// ============================================================================
// Simple stash-based checkpointing
// Uses git stash create/apply which is safer and preserves gitignored files
// ============================================================================

interface CheckpointData {
  id: string;
  turnIndex: number;
  stashRef: string; // The stash commit SHA
  headRef: string; // HEAD at checkpoint time
  timestamp: number;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --is-inside-work-tree", { cwd });
    return true;
  } catch {
    return false;
  }
}

async function createCheckpoint(
  cwd: string,
  turnIndex: number
): Promise<CheckpointData | null> {
  // Get current HEAD
  const { stdout: headRef } = await execAsync("git rev-parse HEAD", { cwd });

  // Create a stash entry without actually stashing (doesn't modify working dir)
  // This captures staged + unstaged changes to tracked files
  const { stdout: stashRef } = await execAsync(
    "git stash create --include-untracked",
    { cwd }
  );

  const ref = stashRef.trim();

  // If no changes, stash create returns empty string
  // We still want to record the checkpoint for HEAD position
  return {
    id: `turn-${turnIndex}-${Date.now()}`,
    turnIndex,
    stashRef: ref || "", // Empty if no changes
    headRef: headRef.trim(),
    timestamp: Date.now(),
  };
}

async function restoreCheckpoint(
  cwd: string,
  checkpoint: CheckpointData
): Promise<void> {
  // 1. Reset to the HEAD at checkpoint time
  await execAsync(`git reset --hard ${checkpoint.headRef}`, { cwd });

  // 2. If there was a stash, apply it
  if (checkpoint.stashRef) {
    try {
      // Apply stash without removing it (in case we need it again)
      // Using --index to restore staged state as well
      await execAsync(`git stash apply --index ${checkpoint.stashRef}`, {
        cwd,
      });
    } catch {
      // If --index fails (conflicts in index), try without it
      try {
        await execAsync(`git stash apply ${checkpoint.stashRef}`, { cwd });
      } catch (e) {
        throw new Error(
          `Failed to apply stash: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }
}

// ============================================================================
// Hook implementation
// ============================================================================

interface PendingCheckpoint {
  turnIndex: number;
  promise: Promise<CheckpointData | null>;
}

export default function (pi: HookAPI) {
  // Track all checkpoints created this session
  const pendingCheckpoints: PendingCheckpoint[] = [];
  const completedCheckpoints: CheckpointData[] = [];

  let gitAvailable = false;
  let checkpointingFailed = false;

  pi.on("session_start", async (event, ctx) => {
    // Check if we're in a git repo
    gitAvailable = await isGitRepo(ctx.cwd);

    if (gitAvailable) {
      ctx.ui.notify("Git checkpointing enabled", "info");
    }
  });

  pi.on("turn_start", async (event, ctx) => {
    if (!gitAvailable || checkpointingFailed) return;

    // Fire and forget - don't block the turn
    const checkpointPromise = (async (): Promise<CheckpointData | null> => {
      try {
        const data = await createCheckpoint(ctx.cwd, event.turnIndex);
        if (data) {
          completedCheckpoints.push(data);
        }
        return data;
      } catch (e) {
        // Silent failure - disable future attempts
        checkpointingFailed = true;
        return null;
      }
    })();

    pendingCheckpoints.push({
      turnIndex: event.turnIndex,
      promise: checkpointPromise,
    });
  });

  pi.on("branch", async (event, ctx) => {
    if (!gitAvailable) return undefined;

    // Wait for all pending checkpoints to complete
    await Promise.all(pendingCheckpoints.map((p) => p.promise));

    // Find the best checkpoint for the target turn
    // We want the checkpoint created AT or BEFORE the target turn
    const validCheckpoints = completedCheckpoints
      .filter((cp) => cp.turnIndex <= event.targetTurnIndex)
      .sort((a, b) => b.turnIndex - a.turnIndex); // Sort by turnIndex descending

    if (validCheckpoints.length === 0) {
      // No checkpoint available
      return undefined;
    }

    const checkpoint = validCheckpoints[0]; // Best match (closest to target)

    // Ask user what to do
    const choice = await ctx.ui.select("Restore code state?", [
      "Restore all (files + conversation)",
      "Conversation only (keep current files)",
      "Code only (restore files, keep conversation)",
      "Cancel",
    ]);

    if (!choice || choice === "Cancel") {
      return { skipConversationRestore: true };
    }

    if (choice.startsWith("Code only")) {
      // Restore files but don't branch conversation
      try {
        await restoreCheckpoint(ctx.cwd, checkpoint);
        ctx.ui.notify("Files restored to checkpoint", "info");
      } catch (error) {
        ctx.ui.notify(
          `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
      return { skipConversationRestore: true };
    }

    if (choice.startsWith("Restore all")) {
      // Restore files AND let conversation branch proceed
      try {
        await restoreCheckpoint(ctx.cwd, checkpoint);
        ctx.ui.notify("Files and conversation restored", "info");
      } catch (error) {
        ctx.ui.notify(
          `File restore failed: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
      return undefined; // Let conversation restore proceed
    }

    // "Conversation only" - just let normal branch proceed
    return undefined;
  });
}
