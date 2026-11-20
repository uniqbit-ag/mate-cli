import fs from "node:fs/promises";
import path from "node:path";

import { taskCounts } from "../delivery/overlap";
import { readDeliveryRecord } from "../delivery/record";
import { BUILTIN_ARTIFACT_TYPE, submitType, type Workflow } from "./declaration";
import type { PathProgress, PathSubject } from "./position";

/** The planning artifacts of a built-in-type change, in review order, by file in its folder. */
const BUILTIN_ARTIFACTS: ReadonlyArray<{ id: string; file: string }> = [
  { id: "proposal", file: "proposal.md" },
  { id: "specs", file: "specs/" },
  { id: "design", file: "design.md" },
  { id: "tasks", file: "tasks.md" },
];

/** A change as the Path Position reads it. */
export interface ChangeInput {
  progress: PathProgress;
  subject: PathSubject & { name: string };
}

export interface ChangeInputOptions {
  /** Whether the change validates; only a validation run can say, so true by default. */
  valid?: boolean;
}

const exists = (file: string): Promise<boolean> =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

/**
 * The change adapter: change `name` in `changeDir` as the Path Position's input, from its
 * Delivery Record, for the built-in type its tasks, its review artifacts and its unmerged
 * branches; artifact paths are relative to the companion. Throws on a record that cannot be read.
 */
export async function readChangeInput(
  companionPath: string,
  workflow: Workflow,
  changeDir: string,
  name: string,
  options: ChangeInputOptions = {},
): Promise<ChangeInput> {
  const record = await readDeliveryRecord(changeDir);
  const progress: PathProgress = {
    steps: record?.stages ?? {},
    ...(record?.state ? { state: record.state } : {}),
  };
  if (workflow.submitArtifact === BUILTIN_ARTIFACT_TYPE) {
    const { total, open } = await taskCounts(changeDir);
    progress.plan = {
      valid: options.valid ?? true,
      totalTasks: total,
      completedTasks: total - open,
    };
  }
  const folder = path.relative(companionPath, changeDir).split(path.sep).join("/");
  const declared = submitType(workflow)?.reviews;
  const candidates = declared ?? BUILTIN_ARTIFACTS;
  const present = await Promise.all(
    candidates.map((artifact) => exists(path.join(changeDir, artifact.file))),
  );
  const deliveries = record?.deliveries.filter((entry) => entry.branch !== undefined) ?? [];
  return {
    progress,
    subject: {
      name,
      artifacts: candidates
        // A declared type's reviews are listed whether written yet or not.
        .filter((_, index) => declared !== undefined || present[index])
        .map((artifact) => ({ id: artifact.id, path: `${folder}/${artifact.file}` })),
      unmerged: deliveries
        .filter((entry) => entry.merge?.state !== "merged")
        .map((entry) =>
          deliveries.length > 1 ? `${entry.branch} (${entry.repository})` : entry.branch!,
        ),
    },
  };
}
