// Deny a git call RTK would wrap in a Claude session moved into a linked worktree.
import { movedIntoLinkedWorktree } from "../runtime/entered-worktree";
import {
  companionSelectsRtk,
  runnableGitCommand,
  type RewriteRunner,
} from "../runtime/rtk-git-guard";
import { hookOutcome, type HookEnv, type HookOutcome } from "./hook-io";

interface BashHookInput {
  cwd?: unknown;
  tool_input?: unknown;
}

export interface RtkWorktreeGitDeps {
  rtkSelected?: (cwd: string, env: HookEnv) => boolean;
  rewrite?: RewriteRunner;
}

/**
 * A deny naming the runnable command, else no output. Never `updatedInput`: two
 * rewriting hooks race and the slower one wins, so a rewrite could lose to RTK's.
 * Cheapest checks first; `rtk rewrite` runs only for a moved session with RTK selected.
 */
export function buildRtkWorktreeGit(
  input: unknown,
  env: HookEnv = process.env,
  deps: RtkWorktreeGitDeps = {},
): HookOutcome {
  try {
    const { cwd, tool_input: toolInput } = (input ?? {}) as BashHookInput;
    const command = (toolInput as { command?: unknown } | null | undefined)?.command;
    if (typeof cwd !== "string" || typeof command !== "string") return hookOutcome(null);
    if (!movedIntoLinkedWorktree(cwd, env.CLAUDE_PROJECT_DIR)) return hookOutcome(null);
    if (!(deps.rtkSelected ?? companionSelectsRtk)(cwd, env)) return hookOutcome(null);
    const runnable = runnableGitCommand(command, deps.rewrite);
    if (!runnable) return hookOutcome(null);
    return hookOutcome({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `This session moved into a linked worktree, where Claude Code refuses git run through RTK (rtk git). Run instead: ${runnable}`,
      },
    });
  } catch {
    return hookOutcome(null);
  }
}
