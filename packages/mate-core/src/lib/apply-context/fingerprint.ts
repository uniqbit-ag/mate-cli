import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isSecretFile, type SecretPolicy } from "../../runtime/secret-patterns";
import type { ApplyPayload, ArtifactFingerprint } from "./protocol";

export interface FingerprintOptions {
  /** Directories a referenced file must resolve into; nothing outside them is read. */
  allowedRoots: string[];
  secretPolicy: SecretPolicy;
  readFile?: (filePath: string) => Promise<string>;
  realpath?: (filePath: string) => Promise<string>;
}

export type FingerprintResult =
  | {
      ok: true;
      /** Hashes with validated tracked checkbox states normalized; feeds the digest. */
      fingerprints: ArtifactFingerprint[];
      /** Hashes of the bytes as read; detects a file changing during collection. */
      raw: ArtifactFingerprint[];
    }
  | { ok: false; reason: string };

/** A task checkbox line: indent, list marker, the state character, then the task text. */
const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*?)\s*$/;

interface TrackedTask {
  id: string;
  description: string;
  done: boolean;
  line: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isUnder(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Every file path the payload references: `contextFiles` values and task source paths. */
function referencedPaths(payload: ApplyPayload): string[] | string {
  const paths = new Set<string>();
  const contextFiles = payload.contextFiles;
  if (contextFiles !== undefined) {
    if (contextFiles === null || typeof contextFiles !== "object" || Array.isArray(contextFiles)) {
      return "contextFiles has an unsupported shape";
    }
    for (const value of Object.values(contextFiles)) {
      const list = Array.isArray(value) ? value : [value];
      for (const entry of list) {
        if (typeof entry !== "string") return "contextFiles has an unsupported shape";
        paths.add(entry);
      }
    }
  }
  if (Array.isArray(payload.tasks)) {
    for (const task of payload.tasks as Record<string, unknown>[]) {
      if (task && typeof task.sourcePath === "string") paths.add(task.sourcePath);
    }
  }
  return [...paths].sort();
}

/** Tasks per source file; a string names the ambiguity that disables compaction. */
function trackedTasks(payload: ApplyPayload): Map<string, TrackedTask[]> | string {
  const byFile = new Map<string, TrackedTask[]>();
  if (!Array.isArray(payload.tasks)) return byFile;
  const locations = new Set<string>();
  for (const task of payload.tasks as Record<string, unknown>[]) {
    if (!task || task.sourcePath === undefined) continue;
    const { id, description, done, sourcePath, line } = task;
    if (
      typeof sourcePath !== "string" ||
      typeof id !== "string" ||
      typeof description !== "string" ||
      typeof done !== "boolean" ||
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < 1
    ) {
      return `task ${String(id)} has an unsupported source location`;
    }
    const location = `${sourcePath}:${line}`;
    if (locations.has(location)) return `two tasks share the source location ${location}`;
    locations.add(location);
    const list = byFile.get(sourcePath) ?? [];
    list.push({ id, description, done, line });
    byFile.set(sourcePath, list);
  }
  return byFile;
}

/**
 * Normalizes the checkbox state character of each task line that freshly parsed
 * upstream tasks vouch for. Any line that does not match its task, by text or by
 * state, makes the file ambiguous: every other byte stays significant.
 */
function normalizeTracked(content: string, tasks: TrackedTask[]): string | { reason: string } {
  const lines = content.split("\n");
  for (const task of tasks) {
    const match = CHECKBOX.exec(lines[task.line - 1] ?? "");
    if (!match || match[4] !== task.description.trim()) {
      return { reason: `task ${task.id} does not match its source line ${task.line}` };
    }
    if ((match[2] !== " ") !== task.done) {
      return { reason: `task ${task.id} state differs from its source line ${task.line}` };
    }
    lines[task.line - 1] = lines[task.line - 1].replace(
      CHECKBOX,
      (_all, open, _state, close, text) => `${open} ${close}${text}`,
    );
  }
  return lines.join("\n");
}

/**
 * Read-only fingerprints of every referenced artifact. Files outside the allowed
 * roots, secret files, unreadable files, and ambiguous task locations are never
 * guessed around: they disable compaction with a reason.
 */
export async function fingerprintArtifacts(
  payload: ApplyPayload,
  options: FingerprintOptions,
): Promise<FingerprintResult> {
  const readFile = options.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"));
  const realpath = options.realpath ?? fs.realpath;
  const paths = referencedPaths(payload);
  if (typeof paths === "string") return { ok: false, reason: paths };
  const tracked = trackedTasks(payload);
  if (typeof tracked === "string") return { ok: false, reason: tracked };

  const roots: string[] = [];
  for (const root of options.allowedRoots) {
    roots.push(await realpath(root).catch(() => path.resolve(root)));
  }

  const fingerprints: ArtifactFingerprint[] = [];
  const raw: ArtifactFingerprint[] = [];
  for (const filePath of paths) {
    if (!path.isAbsolute(filePath)) return { ok: false, reason: `${filePath} is not absolute` };
    if (isSecretFile(filePath, options.secretPolicy)) {
      return { ok: false, reason: `${path.basename(filePath)} is a secret file and is not read` };
    }
    let resolved: string;
    try {
      resolved = await realpath(filePath);
    } catch {
      return { ok: false, reason: `${filePath} is unreadable` };
    }
    if (!roots.some((root) => isUnder(resolved, root))) {
      return { ok: false, reason: `${filePath} is outside the companion and Working Repository` };
    }
    if (isSecretFile(resolved, options.secretPolicy)) {
      return { ok: false, reason: `${path.basename(resolved)} is a secret file and is not read` };
    }
    let content: string;
    try {
      content = await readFile(resolved);
    } catch {
      return { ok: false, reason: `${filePath} is unreadable` };
    }
    const tasks = tracked.get(filePath);
    const normalized = tasks ? normalizeTracked(content, tasks) : content;
    if (typeof normalized !== "string") return { ok: false, reason: normalized.reason };
    fingerprints.push({ path: filePath, sha256: sha256(normalized) });
    raw.push({ path: filePath, sha256: sha256(content) });
  }
  return { ok: true, fingerprints, raw };
}
