import fs from "node:fs/promises";
import path from "node:path";

import { mateHome } from "./runtime-directory";

/**
 * Record and API access for Mate OpenCode servers: one detached `opencode serve`
 * per Working Repository that keeps `mate opencode -- --bg` sessions running.
 * Shared by the CLI (start, stop) and the plugin inside the server (idle stop).
 */

/** Set to `1` in a Mate OpenCode server's environment, never in a TUI or `run`. */
export const MATE_OPENCODE_SERVER = "MATE_OPENCODE_SERVER";
/** Read once by `opencode serve` at start. */
export const OPENCODE_SERVER_PASSWORD = "OPENCODE_SERVER_PASSWORD";
/** Read by an `opencode --server` client. */
export const OPENCODE_PASSWORD = "OPENCODE_PASSWORD";

export interface OpenCodeServerRecord {
  url: string;
  pid: number;
  /** Identifies the launch environment and guidance the server started with. */
  stamp: string;
  startedAt: string;
  version?: string;
}

export function openCodeServersDir(homeDir?: string): string {
  return path.join(mateHome(homeDir), "opencode-servers");
}

/** `<dir>/<repository id with "/" as "_">`, without extension. */
export function serverFileBase(repositoryId: string, dir = openCodeServersDir()): string {
  return path.join(dir, repositoryId.replaceAll(/[/\\:]/g, "_"));
}

function isRecord(value: unknown): value is OpenCodeServerRecord {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.url === "string" &&
    typeof entry.pid === "number" &&
    typeof entry.stamp === "string" &&
    typeof entry.startedAt === "string"
  );
}

/** Missing or unreadable reads as none. */
export async function readServerRecord(base: string): Promise<OpenCodeServerRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(`${base}.json`, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readServerPassword(base: string): Promise<string | null> {
  try {
    return (await fs.readFile(`${base}.key`, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/** Removes the record files of the server with `pid`; a newer server's record stays. */
export async function removeServerRecordOf(pid: number, dir = openCodeServersDir()): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const base = path.join(dir, name.slice(0, -".json".length));
        if ((await readServerRecord(base))?.pid !== pid) return;
        await Promise.all([".json", ".key"].map((ext) => fs.rm(`${base}${ext}`, { force: true })));
      }),
  );
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function authHeaders(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

/**
 * Ids of the sessions with a running execution in this server, or null when
 * it does not answer.
 */
export async function activeSessions(
  url: string,
  password: string,
  fetcher: Fetch = fetch,
): Promise<string[] | null> {
  try {
    const response = await fetcher(`${url}/api/session/active`, {
      headers: authHeaders(password),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: Record<string, unknown> };
    return Object.keys(body.data ?? {});
  } catch {
    return null;
  }
}

export type InterruptOutcome = "interrupted" | "idle" | "unknown-session";

/** Interrupts the session's running turn; throws when the server does not answer. */
export async function interruptSession(
  url: string,
  password: string,
  id: string,
  fetcher: Fetch = fetch,
): Promise<InterruptOutcome> {
  const response = await fetcher(`${url}/api/session/${encodeURIComponent(id)}/interrupt`, {
    method: "POST",
    headers: authHeaders(password),
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return "unknown-session";
  if (!response.ok) throw new Error(`OpenCode server answered ${response.status}`);
  const body = (await response.json()) as { interrupted?: boolean };
  return body.interrupted ? "interrupted" : "idle";
}
