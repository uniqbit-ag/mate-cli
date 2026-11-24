// oxlint-disable no-await-in-loop -- a few small files, read in order
import fs from "node:fs/promises";
import path from "node:path";

import {
  activeChanges,
  archiveAnchors,
  changeNameOf,
  changesDirOf,
  deltaSpecs,
  isChangeName,
} from "../change-layout";
import { readFrontmatter } from "../frontmatter";
import { pendingSubmittedChanges } from "../../runtime/pending-records";
import { readDeliveryRecord } from "./record";
import { isMateSchema } from "./stages";

export interface RequirementEdit {
  capability: string;
  requirement: string;
  operation: "MODIFIED" | "REMOVED";
}

export type DependencyWarning = { kind: "dependency"; change: string; message: string };

export type PlanningWarning = {
  kind: "incomplete-planning";
  change: string;
  artifacts: string[];
  message: string;
};

/** The record names a branch that is no branch name, or different branches per repository. */
export type GroupWarning = { kind: "group"; change: string; message: string };

/** A required stage of the Delivery Path before submit is unfinished for the change. */
export type StageWarning = { kind: "stage-open"; change: string; stage: string; message: string };

/** Submitting counts steps before `mate-submit-change` nobody reported; `steps` by stage id. */
export type CountedWarning = {
  kind: "step-counted";
  change: string;
  steps: Record<string, string[]>;
  message: string;
};

export type SubmitWarning =
  | { kind: "overlap"; change: string; capability: string; requirement: string; message: string }
  | DependencyWarning
  | PlanningWarning
  | GroupWarning
  | StageWarning
  | CountedWarning;

const SECTION = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/;
const REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/;
const TASK = /^\s*[-*]\s+\[([ xX])\]/;

/** Requirements a change's delta specs MODIFY or REMOVE, by full capability path. */
export async function deltaRequirementEdits(changeDir: string): Promise<RequirementEdit[]> {
  const edits: RequirementEdit[] = [];
  for (const { file, capability } of await deltaSpecs(changeDir)) {
    if (capability === null) continue;
    let source: string;
    try {
      source = await fs.readFile(path.join(changeDir, "specs", file), "utf8");
    } catch {
      continue;
    }
    let section: string | null = null;
    for (const line of source.split(/\r?\n/)) {
      const heading = SECTION.exec(line);
      if (heading) {
        section = heading[1];
        continue;
      }
      if (line.startsWith("## ")) section = null;
      const requirement = REQUIREMENT.exec(line);
      if (requirement && (section === "MODIFIED" || section === "REMOVED")) {
        edits.push({ capability, requirement: requirement[1], operation: section });
      }
    }
  }
  return edits;
}

/** Change names listed under `dependsOn` in any of the change's artifact frontmatter. */
export async function declaredDependencies(changeDir: string): Promise<string[]> {
  let files: string[];
  try {
    files = (await fs.readdir(changeDir)).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const file of files) {
    let source: string;
    try {
      source = await fs.readFile(path.join(changeDir, file), "utf8");
    } catch {
      // An unreadable entry (a folder, a file gone since the listing) declares nothing.
      continue;
    }
    // A malformed header declares nothing; validation reports it elsewhere.
    const dependsOn = readFrontmatter(source)?.dependsOn;
    for (const name of Array.isArray(dependsOn) ? dependsOn : [dependsOn]) {
      // Names become paths under the changes folder: only a single segment counts.
      if (typeof name === "string" && isChangeName(name.trim())) names.add(name.trim());
    }
  }
  return [...names].toSorted();
}

async function archivedChangeNames(companionPath: string): Promise<Set<string>> {
  return new Set((await archiveAnchors(companionPath)).map(changeNameOf));
}

/** True when the change's `tasks.md` has tasks and every one is checked. */
async function tasksComplete(changeDir: string): Promise<boolean> {
  let source: string;
  try {
    source = await fs.readFile(path.join(changeDir, "tasks.md"), "utf8");
  } catch {
    return false;
  }
  const marks = source.split(/\r?\n/).flatMap((line) => TASK.exec(line)?.[1] ?? []);
  return marks.length > 0 && marks.every((mark) => mark !== " ");
}

/** The tasks in the change's `tasks.md` and how many are unchecked; none without the file. */
export async function taskCounts(changeDir: string): Promise<{ total: number; open: number }> {
  let source: string;
  try {
    source = await fs.readFile(path.join(changeDir, "tasks.md"), "utf8");
  } catch {
    return { total: 0, open: 0 };
  }
  const marks = source.split(/\r?\n/).flatMap((line) => TASK.exec(line)?.[1] ?? []);
  return { total: marks.length, open: marks.filter((mark) => mark === " ").length };
}

/** The unchecked tasks in the change's `tasks.md`; none without the file. */
export async function openTasks(changeDir: string): Promise<number> {
  return (await taskCounts(changeDir)).open;
}

/**
 * Warnings shown before applying `change`: declared dependencies neither archived nor fully
 * implemented, so the change would be built without the code it builds on. Never blocks.
 */
export async function applyWarnings(
  companionPath: string,
  change: string,
): Promise<DependencyWarning[]> {
  const changesDir = changesDirOf(companionPath);
  const archived = await archivedChangeNames(companionPath);
  const warnings: DependencyWarning[] = [];
  for (const dependency of await declaredDependencies(path.join(changesDir, change))) {
    if (archived.has(dependency) || (await tasksComplete(path.join(changesDir, dependency)))) {
      continue;
    }
    warnings.push({
      kind: "dependency",
      change: dependency,
      message: `${change} depends on ${dependency}, which is not implemented yet; apply ${dependency} first.`,
    });
  }
  return warnings;
}

/**
 * Warning for schema artifacts that `openspec status --change <change> --json` reports neither
 * done nor skipped, e.g. a design missing after a `mate-minimal` change moved to `mate-full`.
 * Only Mate's schemas, legacy aliases included, require every artifact; OpenSpec reports another
 * schema's conditional artifacts (spec-driven's design) as `ready`, so those yield no warning, as
 * does unparsable output.
 */
export function planningWarning(change: string, statusJson: string): PlanningWarning | null {
  let status: { schemaName?: unknown; artifacts?: unknown };
  try {
    status = JSON.parse(statusJson) as typeof status;
  } catch {
    return null;
  }
  const { schemaName, artifacts } = status ?? {};
  if (typeof schemaName !== "string" || !isMateSchema(schemaName)) return null;
  if (!Array.isArray(artifacts)) return null;
  const missing = artifacts
    .filter((artifact): artifact is { id: string; status?: unknown } => {
      return typeof artifact?.id === "string";
    })
    .filter((artifact) => artifact.status !== "done" && artifact.status !== "skipped")
    .map(({ id }) => id);
  if (missing.length === 0) return null;
  return {
    kind: "incomplete-planning",
    change,
    artifacts: missing,
    message: `${change} is missing planning artifacts its schema requires: ${missing.join(", ")}.`,
  };
}

function requirementKey(edit: RequirementEdit): string {
  return JSON.stringify([edit.capability, edit.requirement]);
}

/** The local state of change `name`'s Delivery Record; `active` when unreadable or absent. */
async function stateOf(changesDir: string, name: string): Promise<string> {
  const record = await readDeliveryRecord(path.join(changesDir, name)).catch(() => null);
  return record?.state ?? "active";
}

/**
 * Warnings shown before submitting `change`: another change MODIFYing or REMOVing a requirement
 * this change also MODIFIES or REMOVES, and declared dependencies neither submitted, here or on
 * the inbox as last fetched, nor published. Dropped changes are ignored. Warnings inform; they never block submit.
 */
export async function submitWarnings(
  companionPath: string,
  change: string,
): Promise<SubmitWarning[]> {
  const changesDir = changesDirOf(companionPath);
  const warnings: SubmitWarning[] = [];

  const own = await deltaRequirementEdits(path.join(changesDir, change));
  if (own.length > 0) {
    const ownKeys = new Set(own.map(requirementKey));
    for (const other of await activeChanges(companionPath)) {
      if (other === change || (await stateOf(changesDir, other)) === "dropped") continue;
      for (const edit of await deltaRequirementEdits(path.join(changesDir, other))) {
        if (!ownKeys.has(requirementKey(edit))) continue;
        warnings.push({
          kind: "overlap",
          change: other,
          capability: edit.capability,
          requirement: edit.requirement,
          message: `${other} also changes ${edit.capability} › ${edit.requirement}; unless both publish in one Delivery Group, the one published second is refused as a conflict until it is resolved.`,
        });
      }
    }
  }

  const archived = await archivedChangeNames(companionPath);
  // A teammate's submitted change is on the inbox only; read once, when a dependency needs it.
  let inbox: Set<string> | undefined;
  for (const dependency of await declaredDependencies(path.join(changesDir, change))) {
    if (archived.has(dependency) || (await stateOf(changesDir, dependency)) === "submitted") {
      continue;
    }
    inbox ??= new Set(
      (await pendingSubmittedChanges(companionPath).catch(() => [])).map((entry) => entry.name),
    );
    if (inbox.has(dependency)) continue;
    warnings.push({
      kind: "dependency",
      change: dependency,
      message: `${change} depends on ${dependency}, which is neither submitted nor published; submit ${dependency} with it or first.`,
    });
  }
  return warnings;
}
