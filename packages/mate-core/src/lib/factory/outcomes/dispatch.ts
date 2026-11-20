import path from "node:path";

import { archiveAnchors, changesDirOf } from "../../change-layout";
import { declaredDependencies } from "../../delivery/overlap";
import { readWorkInventory } from "../../workset/inventory";
import {
  findWorkset,
  setWorksetStarted,
  type WorksetRecord,
  writeWorkset,
} from "../../workset/record";
import { planProblems } from "../../workset/sharing";
import { StageError, taskCounts } from "../runner/workflow";

/**
 * What Start in local factory continues: an idea enters planning, a complete unapplied plan
 * waits for review, an incomplete one resumes planning. Implemented, archived, conflicting
 * or dependency-blocked work is refused naming its state; nothing is rewritten.
 */
export interface DispatchPlan {
  record: WorksetRecord;
  implicit: boolean;
  /** An incomplete plan whose planning resumes on the same changes. */
  resume: boolean;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].toSorted();
  const right = [...new Set(b)].toSorted();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export async function dispatchPlan(
  companionPath: string,
  id: string,
  expectedMembers: readonly string[],
): Promise<DispatchPlan> {
  const inventory = await readWorkInventory(companionPath);
  const entry = inventory.worksets.find((candidate) => candidate.id === id);
  if (!entry) throw new StageError(`this companion has no Workset ${id}`);
  if (!entry.actionable) throw new StageError(entry.diagnostics[0] ?? `Workset ${id} cannot start`);
  const active = entry.members.filter((member) => member.kind === "active").map((m) => m.name);
  if (!sameSet(active, expectedMembers)) {
    throw new StageError(
      `its members changed to ${active.join(", ") || "none"}; review them and confirm again`,
    );
  }
  if (active.length === 0 && entry.members.some((member) => member.kind === "archived")) {
    throw new StageError(`Workset ${id} is archived; there is nothing left to dispatch`);
  }
  if (entry.record.repositories.length !== 1) {
    throw new StageError(
      `Workset ${id} names ${entry.record.repositories.length} repositories; the factory runs one`,
    );
  }
  for (const change of active) {
    // oxlint-disable-next-line no-await-in-loop -- few members per Workset
    const { done } = await taskCounts(path.join(changesDirOf(companionPath), change));
    if (done > 0) {
      throw new StageError(
        `${change} is partially implemented (${done} tasks done); continue it in place instead of dispatching it afresh`,
      );
    }
  }
  const archived = new Set(
    (await archiveAnchors(companionPath)).map((anchor) =>
      anchor.replace(/^\d{4}-\d{2}-\d{2}-/, ""),
    ),
  );
  const external: string[] = [];
  for (const change of active) {
    // oxlint-disable-next-line no-await-in-loop -- few members per Workset
    for (const dependency of await declaredDependencies(
      path.join(changesDirOf(companionPath), change),
    )) {
      if (!active.includes(dependency) && !archived.has(dependency)) external.push(dependency);
    }
  }
  if (external.length > 0) {
    throw new StageError(
      `depends on ${[...new Set(external)].join(", ")}, which is neither in this Workset nor archived; archive it or add it first`,
    );
  }
  const resume = active.length > 0 && (await planProblems(companionPath, active)).length > 0;
  return { record: entry.record, implicit: entry.implicit, resume };
}

/** Writes the record an implicit Workset needs, then assigns it to the factory. */
export async function materializeForFactory(
  companionPath: string,
  plan: DispatchPlan,
  mode: "propose-only" | "delivery",
  now: () => Date = () => new Date(),
): Promise<void> {
  if (plan.implicit && !(await findWorkset(companionPath, plan.record.id))) {
    await writeWorkset(companionPath, {
      ...plan.record,
      createdAt: plan.record.createdAt || now().toISOString(),
    });
  }
  const started = await setWorksetStarted(companionPath, plan.record.id, true, now);
  // Propose only names the intended stop; both modes stop at review either way.
  await writeWorkset(companionPath, {
    ...started,
    extra: { ...started.extra, dispatchMode: mode },
  });
}
