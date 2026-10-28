import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { generatedHeader } from "../../runtime/projection";
import { reconcileWorkingRepoCapabilityExcludes } from "../../tools/setup/working-repo-local-state";
import { ensureStoreRegistration } from "./openspec-store";
import {
  excludeRemovalReport,
  type ProjectionSelfRemoval,
  type ProjectionWriteReport,
  type ProjectionWriteState,
} from "./projection-types";

/**
 * The store pointer: an `openspec/config.yaml` in the Working Repository that
 * declares the companion's OpenSpec store. Run from inside the repository,
 * OpenSpec then plans in the store and names the repository as the edit root.
 *
 * The pointer's whole `openspec/` folder is hidden only through
 * `.git/info/exclude`, never the repository's own `.gitignore`: all planning
 * lives in the store, so nothing under it belongs to the repository. Mate
 * never writes it where the repository already owns an OpenSpec root.
 */

const execFileAsync = promisify(execFile);

export const OPENSPEC_POINTER_PATH = path.join("openspec", "config.yaml");
/** The exclusion line, outside the managed block so a core-block rewrite keeps it. */
export const OPENSPEC_POINTER_EXCLUDE = "/openspec/";
/** The earlier file-only line; still managed so a refresh replaces it. */
const LEGACY_POINTER_EXCLUDE = "/openspec/config.yaml";
const MANAGED_POINTER_EXCLUDES = [OPENSPEC_POINTER_EXCLUDE, LEGACY_POINTER_EXCLUDE];

export type StorePointer = { kind: "absent" } | { kind: "foreign" } | { kind: "mate"; id: string };

function pointerFile(repoPath: string): string {
  return path.join(repoPath, OPENSPEC_POINTER_PATH);
}

function renderPointer(id: string): string {
  return `${generatedHeader()}\nstore: ${id}\n`;
}

async function exists(candidate: string): Promise<boolean> {
  return fs
    .access(candidate)
    .then(() => true)
    .catch(() => false);
}

export async function readStorePointer(repoPath: string): Promise<StorePointer> {
  const content = await fs.readFile(pointerFile(repoPath), "utf8").catch(() => null);
  if (content === null) return { kind: "absent" };
  const [first, ...rest] = content.split(/\r?\n/);
  if (first !== generatedHeader()) return { kind: "foreign" };
  const store = rest.map((line) => /^store:\s*(\S+)\s*$/.exec(line)?.[1]).find(Boolean);
  return { kind: "mate", id: store ?? "" };
}

/**
 * Why Mate may not point this repository at a store, or `null` when it may: a
 * config Mate did not write, or a planning root of the repository's own.
 */
export async function storePointerIneligibility(repoPath: string): Promise<string | null> {
  if ((await readStorePointer(repoPath)).kind === "foreign") {
    return `${pointerFile(repoPath)} is not Mate's`;
  }
  for (const dir of ["specs", "changes"]) {
    const planningRoot = path.join(repoPath, "openspec", dir);
    // oxlint-disable-next-line no-await-in-loop -- two probes, first hit wins
    if (await exists(planningRoot)) return `${planningRoot} is the repository's own OpenSpec root`;
  }
  return null;
}

/**
 * Whether Git would show the pointer, asked of Git itself so a re-including
 * rule anywhere above the exclude file counts. `null` when the pointer stays
 * out of every diff, including outside a Git work tree.
 */
export async function pointerIgnoreProblem(repoPath: string): Promise<string | null> {
  const pointer = OPENSPEC_POINTER_PATH.split(path.sep).join("/");
  try {
    await execFileAsync("git", ["check-ignore", "-q", pointer], { cwd: repoPath });
    return null;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) return null;
  }
  const { stdout } = await execFileAsync("git", ["check-ignore", "-v", "-n", pointer], {
    cwd: repoPath,
  }).catch(() => ({ stdout: "" }));
  const [source, line, pattern] = stdout.split("\t")[0]?.split(":") ?? [];
  return pattern
    ? `${pointer} is re-included by "${pattern}" (${source}:${line})`
    : `${pointer} is not ignored by Git`;
}

async function persistPointer(repoPath: string, id: string): Promise<void> {
  await fs.mkdir(path.dirname(pointerFile(repoPath)), { recursive: true });
  await fs.writeFile(pointerFile(repoPath), renderPointer(id), "utf8");
}

export async function writeStorePointer(
  repoPath: string,
  id: string,
): Promise<"written" | "current"> {
  const current = await readStorePointer(repoPath);
  if (current.kind === "mate" && current.id === id) return "current";
  await persistPointer(repoPath, id);
  return "written";
}

/** Only Mate's pointer; `openspec/` goes too when nothing else is left in it. */
export async function removeStorePointer(repoPath: string): Promise<"removed" | "absent"> {
  if ((await readStorePointer(repoPath)).kind !== "mate") return "absent";
  await fs.rm(pointerFile(repoPath));
  await fs.rmdir(path.dirname(pointerFile(repoPath))).catch(() => {});
  return "removed";
}

export async function storePointerPresent(repoPath: string): Promise<boolean> {
  return (await readStorePointer(repoPath)).kind === "mate";
}

/** Another Checkout of the clone needs the line while it carries Mate's pointer. */
async function pointerNeeds(checkout: string): Promise<readonly string[]> {
  return (await storePointerPresent(checkout)) ? [OPENSPEC_POINTER_EXCLUDE] : [];
}

/**
 * Sets the pointer's exclusion line to `desired`, keeping it while another
 * Checkout of the clone carries Mate's pointer. A line kept that way also
 * hides this Checkout's own `openspec/` files, which the warning says.
 */
async function editPointerExclude(repoPath: string, desired: string[]) {
  const result = await reconcileWorkingRepoCapabilityExcludes(
    repoPath,
    desired,
    MANAGED_POINTER_EXCLUDES,
    pointerNeeds,
  );
  const folder = path.join(repoPath, "openspec");
  const hidden = result.kept.includes(OPENSPEC_POINTER_EXCLUDE) && (await exists(folder));
  const warnings = hidden
    ? [
        `untracked files under ${folder} are hidden from Git: the shared exclude line ${OPENSPEC_POINTER_EXCLUDE} stays for ${result.keptFor.join(", ")}`,
      ]
    : [];
  return { result, warnings };
}

/**
 * Keeps the exclusion line while the repository may carry Mate's pointer, or
 * another Checkout of the clone carries it.
 */
export async function reconcileStorePointerExclude(
  repoPath: string,
): Promise<ProjectionWriteState | ProjectionWriteReport> {
  const eligible = (await storePointerIneligibility(repoPath)) === null;
  const { result, warnings } = await editPointerExclude(
    repoPath,
    eligible ? [OPENSPEC_POINTER_EXCLUDE] : [],
  );
  const state = result.changed ? "written" : "current";
  return warnings.length > 0 ? { state, warnings } : state;
}

export async function removeStorePointerExclude(repoPath: string): Promise<ProjectionSelfRemoval> {
  const { result, warnings } = await editPointerExclude(repoPath, []);
  const report = excludeRemovalReport(result);
  return typeof report === "object" && warnings.length > 0 ? { ...report, warnings } : report;
}

function pointerNotWritten(reason: string): ProjectionWriteReport {
  return { state: "skipped", warnings: [`OpenSpec store pointer not written: ${reason}`] };
}

/**
 * Eligibility, then registration, then the pointer: a pointer naming a store
 * OpenSpec cannot resolve would break every root-resolving command. Git is
 * asked about the pointer only before it is created or rewritten, so a
 * steady-state refresh spawns nothing.
 */
export async function projectStorePointer(
  repoPath: string,
  companionPath: string,
): Promise<ProjectionWriteState | ProjectionWriteReport> {
  /** A companion without OpenSpec has no store to point at; nothing to say. */
  if (!(await exists(path.join(companionPath, "openspec")))) return "skipped";
  const ineligible = await storePointerIneligibility(repoPath);
  if (ineligible) return pointerNotWritten(ineligible);
  const registration = await ensureStoreRegistration(companionPath);
  if (registration.state === "skipped") return pointerNotWritten(registration.reason);
  const current = await readStorePointer(repoPath);
  if (current.kind === "mate" && current.id === registration.id) return registration.state;
  const ignoreProblem = await pointerIgnoreProblem(repoPath);
  if (ignoreProblem) return pointerNotWritten(ignoreProblem);
  await persistPointer(repoPath, registration.id);
  return "written";
}
