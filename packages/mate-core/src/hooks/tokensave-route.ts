// Route a Claude session's tokensave calls to the linked worktree it works in.
import { routeTokensaveInput } from "../runtime/tokensave-route";
import { hookOutcome, runHook, type HookOutcome } from "./hook-io";

interface TokensaveHookInput {
  cwd?: unknown;
  tool_input?: unknown;
}

/**
 * `updatedInput` when the call should run against the session directory's
 * worktree, else no output. Never a permission decision: the call keeps its
 * own permission flow. Input-pure, so the plugin copy and a carried copy
 * emit the same rewrite and the call is routed once either way.
 */
export function buildTokensaveRoute(input: unknown): HookOutcome {
  const { cwd, tool_input: toolInput } = (input ?? {}) as TokensaveHookInput;
  const updatedInput = typeof cwd === "string" ? routeTokensaveInput(cwd, toolInput) : undefined;
  return hookOutcome(
    updatedInput ? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } } : null,
  );
}

/** Plugin-shim entry; any failure passes the call unchanged. */
export function run(): Promise<number> {
  return runHook(buildTokensaveRoute, () => hookOutcome(null));
}
