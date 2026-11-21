// The turn hook's state folder and fast prefilters, shared by the Claude plugin's
// workflow-turn shim and src/hooks/workflow-turn.ts. Plain JavaScript with node:
// imports only, so the shim reads it without loading ts-loader.
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

/** Whether `prompt` may start a step: it opens with any runtime's skill prefix. */
export function mayStartStep(prompt) {
  return /^\s*[/@$]/.test(prompt);
}

/** Whether `command` may report a step: it holds `workflow done`. */
export function mayReportStep(command) {
  return /\bworkflow\s+done\b/.test(command);
}
