/**
 * Claude hook-group shape and its one identity. A `runtime/` leaf so hooks and
 * Wrap State can compare groups without loading setup code.
 */

export interface ClaudeHookCommand {
  type?: string;
  command?: string;
  args?: string[];
  timeout?: number;
  /** Claude Code's hook-level permission-rule filter, e.g. `Bash(git *)`. */
  if?: string;
}

export interface ClaudeHookGroup {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
}

/** The one hook-group identity: structurally identical groups are the same group. */
export function hookGroupKey(group: ClaudeHookGroup): string {
  return JSON.stringify(group);
}
