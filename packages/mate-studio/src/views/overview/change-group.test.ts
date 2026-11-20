import { describe, expect, it } from "bun:test";
import type { StudioChange } from "@uniqbit/mate-core/studio";

import { positioned } from "../../../test/positioned";
import {
  activeChanges,
  changeGroup,
  changeProgress,
  changeStep,
  groupChanges,
} from "./change-group";

const change = (overrides: Partial<StudioChange>): StudioChange => ({
  name: "acme-queue",
  artifacts: [],
  ...overrides,
});

describe("activeChanges", () => {
  it("leaves out a change awaiting publication whose folder is checked out", () => {
    const local = [change({ name: "acme-login" }), change({ name: "acme-queue" })];
    const submitted = [{ name: "acme-login", group: "", blocked: false, mine: true }];
    expect(activeChanges(local, submitted).map((entry) => entry.name)).toEqual(["acme-queue"]);
  });

  it("keeps a change whose folder holds work its submitted namesake lacks", () => {
    const local = [change({ name: "acme-login", unsubmitted: true })];
    const submitted = [{ name: "acme-login", group: "", blocked: false, mine: false }];
    expect(activeChanges(local, submitted).map((entry) => entry.name)).toEqual(["acme-login"]);
  });
});

describe("changeGroup", () => {
  it("puts a change with no task done under Needs you", () => {
    expect(changeGroup(change({ completedTasks: 0, totalTasks: 16 }))).toBe("needs-you");
  });

  it("puts a change without tracked tasks under Needs you", () => {
    expect(changeGroup(change({}))).toBe("needs-you");
  });

  it("puts a change with a validation issue under Needs you whatever its progress", () => {
    expect(changeGroup(change({ completedTasks: 7, totalTasks: 7, valid: false }))).toBe(
      "needs-you",
    );
  });

  it("puts a partly done change under Implementation started and a finished one under Ready", () => {
    expect(changeGroup(change({ completedTasks: 12, totalTasks: 20 }))).toBe("building");
    expect(changeGroup(change({ completedTasks: 7, totalTasks: 7 }))).toBe("ready");
  });

  it("lists each change once, in its group", () => {
    const groups = groupChanges([
      change({ name: "a", completedTasks: 0, totalTasks: 16 }),
      change({ name: "b", completedTasks: 12, totalTasks: 20 }),
      change({ name: "c", completedTasks: 7, totalTasks: 7 }),
    ]);
    expect(groups["needs-you"].map((entry) => entry.name)).toEqual(["a"]);
    expect(groups.building.map((entry) => entry.name)).toEqual(["b"]);
    expect(groups.ready.map((entry) => entry.name)).toEqual(["c"]);
  });
});

describe("changeStep", () => {
  const step = (overrides: Partial<StudioChange>) => changeStep(positioned(change(overrides)));

  it("keeps a change whose plan does not validate at Propose change", () => {
    expect(step({ completedTasks: 7, totalTasks: 7, valid: false, issueCount: 2 })).toMatchObject({
      stage: "Propose change",
      situation: "the change does not validate",
      prompt: "/mate-propose-change acme-queue",
    });
  });

  it("offers the submit prompt once every task is done", () => {
    expect(step({ completedTasks: 7, totalTasks: 7 })).toMatchObject({
      stage: "Submit change",
      prompt: "/mate-submit-change acme-queue",
    });
  });

  it("names the open tasks while building, as `mate workflow next` does", () => {
    expect(step({ completedTasks: 2, totalTasks: 4 })).toMatchObject({
      stage: "Apply change",
      situation: "2 tasks open",
      prompt: "/mate-apply-change acme-queue",
    });
  });

  it("names the reviews, then the stage after them", () => {
    expect(step({ completedTasks: 0, totalTasks: 4 })).toMatchObject({
      stage: "Human review",
      review: true,
      next: "Review the plan, then run Apply change",
      prompt: "/mate-apply-change acme-queue",
    });
  });

  it("places nothing without a position", () => {
    expect(changeStep(change({ completedTasks: 2, totalTasks: 4 }))).toMatchObject({
      stageId: null,
      prompt: "",
    });
  });
});

describe("changeProgress", () => {
  const artifacts = [
    { id: "proposal", status: "done" },
    { id: "specs", status: "done" },
    { id: "design", status: "ready" },
    { id: "tasks", status: "blocked" },
  ];

  it("counts the plan's artifacts while no task is done", () => {
    expect(changeProgress(change({ artifacts }))).toEqual({
      done: 2,
      total: 4,
      unit: "artifacts",
    });
    expect(changeProgress(change({ artifacts, completedTasks: 0, totalTasks: 16 })).unit).toBe(
      "artifacts",
    );
  });

  it("counts tasks once the plan is complete and tasks are listed", () => {
    const planned = artifacts.map((artifact) => ({ ...artifact, status: "done" }));
    expect(
      changeProgress(change({ artifacts: planned, completedTasks: 0, totalTasks: 16 })),
    ).toEqual({
      done: 0,
      total: 16,
      unit: "tasks",
    });
  });

  it("counts tasks from the first completed task on", () => {
    expect(changeProgress(change({ artifacts, completedTasks: 12, totalTasks: 20 }))).toEqual({
      done: 12,
      total: 20,
      unit: "tasks",
    });
  });

  it("counts tasks when no artifact is known", () => {
    expect(changeProgress(change({ completedTasks: 0, totalTasks: 16 }))).toEqual({
      done: 0,
      total: 16,
      unit: "tasks",
    });
  });
});
