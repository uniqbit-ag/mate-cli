import fs from "node:fs/promises";

import {
  patchSession,
  type RegisteredSession,
  type SessionRuntime,
  type WriteOptions,
} from "../runtime/session-registry";

/**
 * Records the change a command works on against the agent session it runs
 * in. The session id comes from the runtime's own environment; outside an
 * agent session, or for an unregistered id, nothing changes. Never throws.
 */

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

export function currentSessionId(env: Record<string, string | undefined>): string | null {
  return currentSession(env)?.id ?? null;
}

export interface Attribution {
  change: string;
  /** The worktree the session is about to move to, with its branch. */
  move?: { cwd: string; branch: string };
}

export async function attributeCurrentSession(
  attribution: Attribution,
  env: Record<string, string | undefined> = process.env,
  options: WriteOptions = { lock: { waitMs: 2000 } },
): Promise<RegisteredSession | null> {
  const id = currentSessionId(env);
  if (!id) return null;
  try {
    const cwd = attribution.move ? await fs.realpath(attribution.move.cwd) : undefined;
    return await patchSession(
      id,
      {
        change: attribution.change,
        ...(attribution.move ? { cwd, branch: attribution.move.branch } : {}),
      },
      options,
    );
  } catch {
    return null;
  }
}
