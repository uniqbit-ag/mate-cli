// Route a Claude session's tokensave calls to the linked worktree it works in.
import { routeTokensaveInput, type RouteDeps } from "../runtime/tokensave-route";
import { hookOutcome, type HookOutcome } from "./hook-io";

interface TokensaveHookInput {
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

/**
 * `updatedInput` when the call should run against the session directory's
 * worktree, else no output. Never a permission decision: the call keeps its
 * own permission flow. Input-pure apart from `CLAUDE_PROJECT_DIR`, the start
 * directory whose checkout the MCP server serves, so the plugin copy and a
 * carried copy emit the same rewrite and the call is routed once either way.
 */
export function buildTokensaveRoute(input: unknown, deps?: RouteDeps): HookOutcome {
  const { cwd, tool_name: tool, tool_input: toolInput } = (input ?? {}) as TokensaveHookInput;
  const updatedInput =
    typeof cwd === "string" && typeof tool === "string"
      ? routeTokensaveInput(tool, cwd, toolInput, {
          servedDirectory: process.env.CLAUDE_PROJECT_DIR,
          ...deps,
        })
      : undefined;
  return hookOutcome(
    updatedInput ? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } } : null,
  );
}
