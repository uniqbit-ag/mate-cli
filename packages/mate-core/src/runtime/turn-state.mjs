// The turn hook's state folder and fast prefilters, shared by the Claude plugin's
// workflow-turn shim, src/hooks/workflow-turn.ts, the OpenCode turn hook and
// `mate workflow done`. Plain JavaScript with node: imports only, so the shim reads it
// without loading ts-loader.
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** The turn state folder in Mate's home folder `mateHome`. */
export function turnStateDir(mateHome) {
  return path.join(mateHome, "turn-hooks");
}

/** The state file name of `session`, any character outside `[A-Za-z0-9_-]` replaced. */
export function sessionFileName(session) {
  return `${session.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

/**
 * Whether an `lstat` of the state folder shows a directory owned by `uid` that no one else can
 * enter; a link is no directory. Without a `uid` (Windows), only the directory is checked.
 */
export function isPrivateDir(stat, uid) {
  if (!stat.isDirectory()) return false;
  return uid === undefined || (stat.uid === uid && (stat.mode & 0o077) === 0);
}

/** Creates `dir` private when missing; throws unless it is a private directory. */
export async function privateTurnDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!isPrivateDir(await fs.lstat(dir), process.getuid?.())) {
    throw new Error(`${dir} is not a private directory`);
  }
  return dir;
}

/**
 * Appends `note` to the state file `file` as one JSON line in a single write, so parallel tool
 * calls each keep theirs; only in a private folder, never through a planted link.
 */
export async function appendTurnNote(file, note) {
  await privateTurnDir(path.dirname(file));
  const { O_APPEND, O_CREAT, O_NOFOLLOW, O_WRONLY } = fsConstants;
  const handle = await fs.open(file, O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.write(`${JSON.stringify(note)}\n`);
  } finally {
    await handle.close();
  }
}

/**
 * The JSON notes of the state file `file`, one per line; none unless its folder is private and
 * the file is no link.
 */
export async function readTurnNotes(file) {
  let content = "";
  try {
    if (!isPrivateDir(await fs.lstat(path.dirname(file)), process.getuid?.())) return [];
    const { O_NOFOLLOW, O_RDONLY } = fsConstants;
    const handle = await fs.open(file, O_RDONLY | (O_NOFOLLOW ?? 0));
    try {
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  return content.split("\n").flatMap((line) => {
    try {
      const note = JSON.parse(line);
      return note && typeof note === "object" ? [note] : [];
    } catch {
      return [];
    }
  });
}

/** The agent session a command runs in, from the runtime's environment; undefined outside one. */
export function turnSession(env) {
  return env.CLAUDE_CODE_SESSION_ID || env.OPENCODE_SESSION_ID || undefined;
}

/** Whether `prompt` may start a step: it opens with any runtime's skill prefix. */
export function mayStartStep(prompt) {
  return /^\s*[/@$]/.test(prompt);
}

/** Whether `command` may report a step: it holds `workflow done`. */
export function mayReportStep(command) {
  return /\bworkflow\s+done\b/.test(command);
}
