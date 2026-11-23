import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { realPath } from "../../runtime/git-layout";
import { processAlive } from "../../runtime/opencode-server-record";
import { isWithin } from "../../runtime/physical-path";
import { mateHome } from "../../runtime/runtime-directory";

const TRIAGE_RETENTION_DAYS = 30;
/** Holds the pid of the `mate triage` process while the agent it started runs. */
const LAUNCHER_FILE = ".mate-triage.pid";
const MAX_ANCESTORS = 64;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `2026-11-16T09-30-00-123Z`, with `-<n>` for runs within one millisecond; names sort as times. */
const SESSION_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/;

export function triageRoot(homeDir?: string): string {
  return path.join(mateHome(homeDir), "triage");
}

/** The triage session folder `cwd` lies in, or null; a stray folder under the triage root is none. */
export function triageSessionDir(cwd: string, homeDir?: string): string | null {
  const root = realPath(triageRoot(homeDir));
  const real = realPath(cwd);
  if (!isWithin(real, root)) return null;
  const [name] = path.relative(root, real).split(path.sep);
  return name && SESSION_NAME.test(name) ? path.join(root, name) : null;
}

function toPid(text: string | undefined): number | null {
  const pid = Number(text?.trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** Linux and macOS; null when unknown or at the top of the tree. */
export function parentPid(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      // The command name in parentheses may hold spaces; state and ppid follow its last ")".
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return toPid(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    }
    // An absolute path: an agent could put its own `ps` first on PATH.
    const ps = spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return ps.status === 0 ? toPid(ps.stdout) : null;
  } catch {
    return null;
  }
}

/** Whether `pid` is an ancestor of this process; on Windows, without a cheap parent lookup, whether it runs. */
export function isAncestorProcess(pid: number): boolean {
  if (process.platform === "win32") return processAlive(pid);
  let current: number | null = process.ppid;
  for (let hop = 0; current !== null && hop < MAX_ANCESTORS; hop += 1) {
    if (current === pid) return true;
    current = parentPid(current);
  }
  return false;
}

/** Records this process as the one running the session's agent; the returned function removes the record. */
export function recordTriageLauncher(sessionDir: string): () => void {
  const file = path.join(sessionDir, LAUNCHER_FILE);
  fs.writeFileSync(file, `${process.pid}\n`, "utf8");
  return () => fs.rmSync(file, { force: true });
}

/**
 * The triage session folder `cwd` lies in, when the `mate triage` recorded there is an ancestor of
 * this process (see `isAncestorProcess`); else null, as for an old session or a folder an agent made.
 */
export function launchedTriageSessionDir(
  cwd: string,
  options: { homeDir?: string; isAncestor?: (pid: number) => boolean } = {},
): string | null {
  const dir = triageSessionDir(cwd, options.homeDir);
  if (!dir) return null;
  let launcher: number | null;
  try {
    launcher = toPid(fs.readFileSync(path.join(dir, LAUNCHER_FILE), "utf8"));
  } catch {
    return null;
  }
  return launcher !== null && (options.isAncestor ?? isAncestorProcess)(launcher) ? dir : null;
}

function sessionName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Only folders named like a triage session go, so a stray file there survives. */
function pruneTriageSessions(root: string, now: Date): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const oldest = sessionName(new Date(now.getTime() - TRIAGE_RETENTION_DAYS * DAY_MS));
  for (const entry of entries) {
    if (entry.isDirectory() && SESSION_NAME.test(entry.name) && entry.name < oldest) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
}

/** Prunes old sessions, then creates a new, empty session folder and returns its path. */
export function createTriageSession(options: { homeDir?: string; now?: Date } = {}): string {
  const now = options.now ?? new Date();
  const root = triageRoot(options.homeDir);
  pruneTriageSessions(root, now);
  fs.mkdirSync(root, { recursive: true });
  const base = sessionName(now);
  for (let attempt = 0; ; attempt += 1) {
    const dir = path.join(root, attempt === 0 ? base : `${base}-${attempt}`);
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
