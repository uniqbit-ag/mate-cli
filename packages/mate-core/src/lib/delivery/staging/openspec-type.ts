import path from "node:path";

import { OPENSPEC_CHANGE_LAYOUT, SPECS_RELATIVE_DIR } from "../../change-layout";
import { fileExists } from "../../fs-utils";
import { runOpenSpec, type RunOpenSpec } from "../../openspec-cli";
import { deltaRequirementEdits, taskCounts } from "../overlap";
import { DELIVERY_FILE } from "../record";
import type { ArtifactType, ReviewFile, ValidationFailure } from "./artifact-type";
import { replayArchive, resolveRequirement, staleRequirement } from "./replay";

/** Name of the OpenSpec type and its trailer prefix. */
const OPENSPEC_TYPE = "openspec";

/** Bound on one OpenSpec run of a hook, so a hung CLI ends as that hook's failure. */
const OPENSPEC_TIMEOUT_MS = 120_000;

/** The planning artifacts of a change, in review order. */
const PLANNING_ARTIFACTS: readonly ReviewFile[] = [
  { id: "proposal", file: "proposal.md" },
  { id: "specs", file: "specs/" },
  { id: "design", file: "design.md" },
  { id: "tasks", file: "tasks.md" },
];

/** The capability of a canonical spec path, or null for any other path. */
function capabilityOf(file: string): string | null {
  const match = new RegExp(`^${SPECS_RELATIVE_DIR}/(.+)/spec\\.md$`).exec(file);
  return match ? match[1]! : null;
}

interface ValidatedItem {
  valid?: boolean;
  issues?: Array<{ level?: string; message?: string }>;
}

/** The `items` of `openspec validate --json` output, or null when it is not that JSON. */
function validatedItems(stdout: string): ValidatedItem[] | null {
  try {
    return (JSON.parse(stdout) as { items?: ValidatedItem[] }).items ?? null;
  } catch {
    return null;
  }
}

/**
 * Validates `capability` in `dir` without `--strict`, so only errors fail it; warnings are
 * common in existing companions and never block a merged change.
 */
async function validateSpec(
  dir: string,
  file: string,
  capability: string,
  runner: RunOpenSpec,
): Promise<ValidationFailure | null> {
  // After `--`, so a teammate's folder named like an option is never parsed as one.
  const run = await runner(
    ["validate", "--type", "spec", "--json", "--no-interactive", "--", capability],
    { cwd: dir, timeout: OPENSPEC_TIMEOUT_MS },
  );
  if (run.code === null) {
    return { path: file, detail: `openspec validate ${capability} ran out of time` };
  }
  const items = validatedItems(run.stdout);
  if (!items) {
    if (run.code === 0) return null;
    const output = (run.stderr || run.stdout).trim().split("\n").slice(-3).join("\n");
    return { path: file, detail: output || `openspec validate ${capability} failed` };
  }
  const invalid = items.find((item) => item.valid === false);
  if (!invalid) return null;
  const errors = (invalid.issues ?? [])
    .filter((issue) => issue.level === "ERROR")
    .map((issue) => issue.message ?? "")
    .filter(Boolean);
  return { path: file, detail: errors.join("; ") || "invalid" };
}

/** Why `openspec validate <change> --strict` refuses the change in `dir`, or null. */
async function checkChange(
  dir: string,
  change: string,
  runner: RunOpenSpec,
): Promise<string | null> {
  const run = await runner(["validate", "--strict", "--no-interactive", "--", change], {
    cwd: dir,
    timeout: OPENSPEC_TIMEOUT_MS,
  });
  if (run.code === 0) return null;
  if (run.code === null) return `openspec validate ${change} --strict ran out of time`;
  const output = (run.stderr || run.stdout).trim().split("\n").slice(-5).join("\n");
  return output || `openspec validate ${change} --strict failed`;
}

/**
 * The built-in OpenSpec type: sources are active change folders, records archive directories,
 * derived files the canonical specs their delta specs name. Its hooks are the only places
 * submit, publication and synchronization run OpenSpec or read its files.
 */
export function openspecArtifactType(runner: RunOpenSpec = runOpenSpec): ArtifactType {
  return {
    name: OPENSPEC_TYPE,
    ...OPENSPEC_CHANGE_LAYOUT,
    deliveryFile: DELIVERY_FILE,
    check: (dir, name) => checkChange(dir, name, runner),
    apply: (dir, name, options) =>
      replayArchive(dir, name, runner, { timeout: OPENSPEC_TIMEOUT_MS, ...options }),
    stale: staleRequirement,
    resolve: resolveRequirement,
    touches: async (changeDir) =>
      (await deltaRequirementEdits(changeDir)).map(({ capability, requirement }) => ({
        capability,
        requirement,
      })),
    async validate(dir, files) {
      for (const file of files) {
        const capability = capabilityOf(file);
        if (!capability) continue;
        // oxlint-disable-next-line no-await-in-loop -- a handful of specs per publication
        const failure = await validateSpec(dir, file, capability, runner);
        if (failure) return failure;
      }
      return null;
    },
    async plan(changeDir) {
      const { total, open } = await taskCounts(changeDir);
      return { totalTasks: total, completedTasks: total - open };
    },
    async reviews(changeDir) {
      const present = await Promise.all(
        PLANNING_ARTIFACTS.map((artifact) => fileExists(path.join(changeDir, artifact.file))),
      );
      return PLANNING_ARTIFACTS.filter((_, index) => present[index]);
    },
  };
}
