import type { SessionRuntime } from "./session-registry";

/** Set by Claude Code and OpenCode for the processes their sessions start; undocumented. */
const SESSION_ID_VARIABLES = [
  ["CLAUDE_CODE_SESSION_ID", "claude"],
  ["OPENCODE_SESSION_ID", "opencode"],
] as const satisfies readonly (readonly [string, SessionRuntime])[];

export function currentSession(
  env: Record<string, string | undefined>,
): { id: string; runtime: SessionRuntime } | null {
  for (const [name, runtime] of SESSION_ID_VARIABLES) {
    const value = env[name]?.trim();
    if (value) return { id: value, runtime };
  }
  return null;
}

/** For a process Mate starts itself, which must not count as the agent's command. */
export function withoutSessionIds(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  for (const [name] of SESSION_ID_VARIABLES) delete rest[name];
  return rest;
}
