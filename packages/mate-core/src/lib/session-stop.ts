import {
  type Fetch,
  interruptSession,
  openCodeServersDir,
  processAlive,
  readServerPassword,
  readServerRecord,
  serverFileBase,
} from "../runtime/opencode-server-record";
import { resolveProjection } from "../runtime/projection";
import {
  endSession,
  readSessionRegistry,
  type RegisteredSession,
  SessionRegistryError,
  sessionRegistryPath,
} from "../runtime/session-registry";

/**
 * `mate session stop`: interrupts an OpenCode background session's running
 * turn through its Mate OpenCode server and marks the session ended.
 */

export interface SessionStopDeps {
  file?: string;
  serversDir?: string;
  repositoryIdOf?: (cwd: string) => string | null;
  alive?: (pid: number) => boolean;
  fetch?: Fetch;
}

const projectedRepositoryId = (cwd: string) => resolveProjection(cwd)?.repositoryId ?? null;

export async function stopSession(
  id: string,
  deps: SessionStopDeps = {},
): Promise<RegisteredSession> {
  const file = deps.file ?? sessionRegistryPath();
  const session = (await readSessionRegistry(file)).sessions.find((entry) => entry.id === id);
  if (!session) throw new SessionRegistryError(`session not registered: ${id}`);
  if (session.runtime !== "opencode") {
    throw new SessionRegistryError(`session ${id} is not an OpenCode session`);
  }
  const repositoryId = (deps.repositoryIdOf ?? projectedRepositoryId)(session.cwd);
  const base =
    repositoryId && serverFileBase(repositoryId, deps.serversDir ?? openCodeServersDir());
  const record = base ? await readServerRecord(base) : null;
  const password = base ? await readServerPassword(base) : null;
  if (!record || !password || !(deps.alive ?? processAlive)(record.pid)) {
    throw new SessionRegistryError(`no Mate OpenCode server runs for session ${id}`);
  }
  /** Another OpenCode process (a standalone TUI) owns it; the server cannot stop it. */
  if (session.pid !== undefined && session.pid !== record.pid) {
    throw new SessionRegistryError(`session ${id} does not run in the Mate OpenCode server`);
  }
  try {
    await interruptSession(record.url, password, id, deps.fetch);
  } catch (error) {
    throw new SessionRegistryError(
      `the Mate OpenCode server at ${record.url} did not stop session ${id}: ${(error as Error).message}`,
    );
  }
  return (await endSession(id, { file }))!;
}
