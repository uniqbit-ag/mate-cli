import fs from "node:fs";
import path from "node:path";

import { mateHome } from "../../runtime/runtime-directory";

const TRIAGE_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `2026-11-16T09-30-00-123Z`, with `-<n>` for runs within one millisecond; names sort as times. */
const SESSION_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/;

export function triageRoot(homeDir?: string): string {
  return path.join(mateHome(homeDir), "triage");
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
