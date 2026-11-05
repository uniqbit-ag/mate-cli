import type { StudioChange } from "@uniqbit/mate-core/studio";

/** What a change needs next, read from its validation and task counts (design D5). */
export type ChangeGroup = "needs-you" | "building" | "ready";

export const CHANGE_GROUPS: readonly ChangeGroup[] = ["needs-you", "building", "ready"];

export const GROUP_TITLES: Record<ChangeGroup, string> = {
  "needs-you": "Needs you",
  building: "Building",
  ready: "Ready to archive",
};

export function changeGroup(change: StudioChange): ChangeGroup {
  const total = change.totalTasks ?? 0;
  const done = change.completedTasks ?? 0;
  if (change.valid === false || total === 0 || done === 0) return "needs-you";
  return done < total ? "building" : "ready";
}

export function groupChanges(changes: StudioChange[]): Record<ChangeGroup, StudioChange[]> {
  const groups: Record<ChangeGroup, StudioChange[]> = { "needs-you": [], building: [], ready: [] };
  for (const change of changes) groups[changeGroup(change)].push(change);
  return groups;
}

export interface ChangeStep {
  /** The Delivery Path stage the change is at. */
  stage: string;
  /** One line on where it is. */
  situation: string;
  /** What the person does next, and the prompt that does it. */
  next: string;
  prompt: string;
}

export function changeStep(change: StudioChange): ChangeStep {
  const total = change.totalTasks ?? 0;
  const done = change.completedTasks ?? 0;
  if (change.valid === false) {
    const issues = change.issueCount ?? 0;
    return {
      stage: "Propose change",
      situation: `${issues} validation ${issues === 1 ? "issue" : "issues"}`,
      next: "Fix the plan so it validates",
      prompt: `/mate-propose-change ${change.name}`,
    };
  }
  if (total === 0) {
    return {
      stage: "Propose change",
      situation: "No tasks yet",
      next: "Finish the plan",
      prompt: `/mate-propose-change ${change.name}`,
    };
  }
  if (done === 0) {
    return {
      stage: "Human review",
      situation: "Plan ready for review",
      next: "Review the plan, then apply it",
      prompt: `/mate-apply-change ${change.name}`,
    };
  }
  if (done < total) {
    return {
      stage: "Apply change",
      situation: `${total - done} ${total - done === 1 ? "task" : "tasks"} left`,
      next: "Continue the build",
      prompt: `/mate-apply-change ${change.name}`,
    };
  }
  return {
    stage: "Archive change",
    situation: "All tasks done",
    next: "Archive the change",
    prompt: `/mate-archive-change ${change.name}`,
  };
}
