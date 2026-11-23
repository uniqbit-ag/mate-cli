import path from "node:path";

import { changeNames, locate } from "../change-layout";
import { readDeliveryRecord, recordStep } from "../delivery/record";
import { submitArtifactType } from "../delivery/staging/registry";
import type { Workflow } from "./declaration";
import type { PathProgress, PathSubject } from "./position";

/**
 * The work a companion's Delivery Path places: today the change folders of the artifact type its
 * submit handles. Callers of the Path Position (`mate workflow`, the turn hooks, Studio, submit's
 * stage warnings) reach work only here and never see a folder, so a source of work that is not a
 * change folder changes this module alone.
 */

/** A piece of work as the Path Position reads it. */
export interface WorkInput {
  progress: PathProgress;
  subject: PathSubject & { name: string };
}

export interface WorkInputOptions {
  /** Whether its plan validates; only a validation run can say, so true by default. */
  valid?: boolean;
}

/** A piece of work that exists. */
export interface WorkItem {
  name: string;
  /**
   * Its Path Position input: its recorded steps and state, its plan when its type has one, the
   * artifacts a review can name (companion-relative) and its unmerged branches. Throws on a
   * record that cannot be read.
   */
  input(options?: WorkInputOptions): Promise<WorkInput>;
  /** Records `skill` as a finished step of `stage`; a step already recorded changes nothing. */
  recordStep(stage: string, skill: string): Promise<void>;
}

export interface Work {
  /** The names of the work that exists, sorted. */
  names(): Promise<string[]>;
  /** The named work; else the problem naming where it was expected and the work that exists. */
  find(name: string): Promise<WorkItem | { problem: string }>;
}

export interface WorkOptions {
  /** Where the change folders live; the companion by default, an OpenSpec store elsewhere. */
  root?: string;
}

/** The work of `workflow`'s companion at `companionPath`. */
export function openWork(
  companionPath: string,
  workflow: Workflow,
  options: WorkOptions = {},
): Work {
  const type = submitArtifactType(workflow);
  const root = options.root ?? companionPath;
  const names = () => changeNames(root, type);

  const item = (name: string, dir: string): WorkItem => ({
    name,
    recordStep: (stage, skill) => recordStep(dir, name, stage, skill),
    async input({ valid = true } = {}) {
      const [record, plan, reviews] = await Promise.all([
        readDeliveryRecord(dir),
        type.plan?.(dir),
        type.reviews?.(dir) ?? [],
      ]);
      const progress: PathProgress = {
        steps: record?.stages ?? {},
        ...(record?.state ? { state: record.state } : {}),
        ...(plan ? { plan: { valid, ...plan } } : {}),
      };
      const folder = path.relative(companionPath, dir).split(path.sep).join("/");
      const deliveries = record?.deliveries.filter((entry) => entry.branch !== undefined) ?? [];
      return {
        progress,
        subject: {
          name,
          artifacts: reviews.map((review) => ({ id: review.id, path: `${folder}/${review.file}` })),
          unmerged: deliveries
            .filter((entry) => entry.merge?.state !== "merged")
            .map((entry) =>
              deliveries.length > 1 ? `${entry.branch} (${entry.repository})` : entry.branch!,
            ),
        },
      };
    },
  });

  return {
    names,
    async find(name) {
      const found = await locate(root, type, name);
      if (found && "dir" in found && !found.archived) return item(name, found.dir);
      const existing = await names();
      const known =
        existing.length > 0 ? `; the changes are ${existing.join(", ")}` : "; there are no changes";
      return {
        problem: `${name} has no change folder at ${type.source}/${name}/${known}.`,
      };
    },
  };
}
