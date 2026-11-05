// oxlint-disable no-await-in-loop
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";

import {
  activeSessions,
  type Fetch,
  MATE_OPENCODE_SERVER,
  OPENCODE_SERVER_PASSWORD,
  type OpenCodeServerRecord,
  openCodeServersDir,
  processAlive,
  readServerPassword,
  readServerRecord,
  serverFileBase,
} from "../runtime/opencode-server-record";
import { withLock } from "../runtime/session-registry";
import { writeAtomic } from "../runtime/write-atomic";

/**
 * Starts or reuses the Mate OpenCode server of a Working Repository. The
 * password lives only in `<repo>.key` (0600) and in environment variables:
 * never in argv, the record, or a log line.
 */

export interface ServerDeps {
  dir: string;
  /** Starts `opencode serve` detached; returns its pid. */
  start: (options: { cwd: string; env: NodeJS.ProcessEnv; port: number; log: string }) => number;
  freePort: () => Promise<number>;
  fetch: Fetch;
  alive: (pid: number) => boolean;
  /** The process's command line, or null when it cannot be read. */
  command: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  password: () => string;
}

const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5000;
const POLL_MS = 200;

function startServe({ cwd, env, port, log }: Parameters<ServerDeps["start"]>[0]): number {
  const fd = fsSync.openSync(log, "a", 0o600);
  try {
    const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    if (child.pid === undefined) throw new Error("opencode serve did not start");
    return child.pid;
  } finally {
    fsSync.closeSync(fd);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no free port")),
      );
    });
  });
}

function commandOf(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Guards a kill of a pid the record names: the server may be gone and the pid reused. */
const isOpenCodeServe = (command: string | null) => /\bopencode\b.*\bserve\b/.test(command ?? "");

export const defaultServerDeps: ServerDeps = {
  dir: openCodeServersDir(),
  start: startServe,
  freePort,
  fetch,
  alive: processAlive,
  command: commandOf,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  password: () => crypto.randomBytes(32).toString("base64url"),
};

/** SHA-256 over the sorted `MATE_*` variables, the guidance payload included. */
export function serverStamp(env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(env)
    .filter(([name, value]) => name.startsWith("MATE_") && name !== MATE_OPENCODE_SERVER && value)
    .toSorted(([a], [b]) => a.localeCompare(b));
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export interface EnsureServerInput {
  repositoryId: string;
  /** Directory the server runs in: the repository's main checkout. */
  cwd: string;
  /** The server's launch environment, guidance included, without password or flag. */
  env: NodeJS.ProcessEnv;
  version?: string;
}

export interface EnsuredServer {
  url: string;
  password: string;
  /** Set when a busy server with an older configuration was reused. */
  warning?: string;
}

async function stopServer(pid: number, deps: ServerDeps): Promise<void> {
  try {
    deps.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let waited = 0; waited < STOP_TIMEOUT_MS; waited += POLL_MS) {
    if (!deps.alive(pid)) return;
    await deps.sleep(POLL_MS);
  }
  try {
    deps.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Waits by the clock, so a server that accepts connections but never answers
 * (each check waiting out its fetch timeout) still gives up in time; the poll
 * count bounds it where the clock stands still.
 */
async function waitReady(url: string, password: string, pid: number, deps: ServerDeps) {
  const started = deps.now().getTime();
  for (let polled = 0; ; polled += POLL_MS) {
    if (Math.max(deps.now().getTime() - started, polled) >= READY_TIMEOUT_MS) return false;
    if ((await activeSessions(url, password, deps.fetch)) !== null) return true;
    if (!deps.alive(pid)) return false;
    await deps.sleep(POLL_MS);
  }
}

async function startServer(
  input: EnsureServerInput,
  base: string,
  stamp: string,
  deps: ServerDeps,
): Promise<EnsuredServer> {
  const log = `${base}.log`;
  // A port taken between pick and bind fails the start; one retry with a new port.
  for (let attempt = 1; ; attempt += 1) {
    const port = await deps.freePort();
    const password = deps.password();
    await writeAtomic(`${base}.key`, `${password}\n`, 0o600);
    const pid = deps.start({
      cwd: input.cwd,
      env: { ...input.env, [MATE_OPENCODE_SERVER]: "1", [OPENCODE_SERVER_PASSWORD]: password },
      port,
      log,
    });
    const url = `http://127.0.0.1:${port}`;
    if (await waitReady(url, password, pid, deps)) {
      const record: OpenCodeServerRecord = {
        url,
        pid,
        stamp,
        startedAt: deps.now().toISOString(),
        ...(input.version ? { version: input.version } : {}),
      };
      await writeAtomic(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`, 0o600);
      return { url, password };
    }
    await stopServer(pid, deps);
    if (attempt >= 2) {
      await fs.rm(`${base}.key`, { force: true });
      throw new Error(`The Mate OpenCode server did not start; see ${log}`);
    }
  }
}

/**
 * Reuses the repository's server while its process lives and its API answers;
 * replaces a stale one (other stamp) only when no session of it is busy, and
 * stops one that no longer answers before starting the next.
 */
export async function ensureOpenCodeServer(
  input: EnsureServerInput,
  deps: ServerDeps = defaultServerDeps,
): Promise<EnsuredServer> {
  await fs.mkdir(deps.dir, { recursive: true, mode: 0o700 });
  const base = serverFileBase(input.repositoryId, deps.dir);
  const stamp = serverStamp(input.env);
  return withLock(
    `${base}.json`,
    async () => {
      const record = await readServerRecord(base);
      const password = await readServerPassword(base);
      if (record && password && deps.alive(record.pid)) {
        const active = await activeSessions(record.url, password, deps.fetch);
        if (active !== null && record.stamp === stamp) return { url: record.url, password };
        if (active !== null && active.length > 0) {
          return {
            url: record.url,
            password,
            warning: `The Mate OpenCode server of ${input.repositoryId} runs with an older configuration; it restarts on the next launch while no session is busy.`,
          };
        }
        // An idle server with an older configuration, or one that stopped answering.
        if (active !== null || isOpenCodeServe(deps.command(record.pid))) {
          await stopServer(record.pid, deps);
        }
      }
      return startServer(input, base, stamp, deps);
    },
    // A start may take the readiness timeout, one last check, and a stop, twice.
    {
      waitMs: 2 * (READY_TIMEOUT_MS + STOP_TIMEOUT_MS) + 10_000,
      staleMs: 2 * (READY_TIMEOUT_MS + STOP_TIMEOUT_MS) + 15_000,
    },
  );
}
