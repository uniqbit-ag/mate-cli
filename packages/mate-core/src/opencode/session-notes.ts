import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { repoLocalDirPath } from "../runtime/repo-local";
import { writeAtomic } from "../runtime/write-atomic";

/**
 * The last plugin prepare's operator notes, per phase. The V2 server API has
 * no toast, so the TUI reads them with its staleness lines and toasts new ones.
 */
export type SessionNotePhase = "prepare" | "sync";

type SessionNotes = Partial<Record<SessionNotePhase, string[]>>;

function notesPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), "session-notes.json");
}

function readAll(repoPath: string): SessionNotes {
  try {
    const parsed = JSON.parse(fs.readFileSync(notesPath(repoPath), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as SessionNotes) : {};
  } catch {
    return {};
  }
}

/** Replaces one phase's notes; an empty list clears them. Best-effort. */
export async function recordSessionNotes(
  repoPath: string,
  phase: SessionNotePhase,
  notes: readonly string[],
): Promise<void> {
  const next: SessionNotes = { ...readAll(repoPath), [phase]: [...notes] };
  const target = notesPath(repoPath);
  try {
    if (Object.values(next).every((lines) => !lines?.length)) {
      await fsp.rm(target, { force: true });
      return;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* the log already carries the notes */
  }
}

export function readSessionNotes(repoPath: string): string[] {
  return Object.values(readAll(repoPath)).flatMap((lines) =>
    Array.isArray(lines) ? lines.filter((line) => typeof line === "string") : [],
  );
}
