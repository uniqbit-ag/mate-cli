import { describe, expect, it } from "bun:test";
import type { StudioChange } from "@uniqbit/mate-core/studio";

import { changeGroup, changeProgress, changeStep, groupChanges } from "./change-group";

const change = (overrides: Partial<StudioChange>): StudioChange => ({
  name: "acme-queue",
  artifacts: [],
  ...overrides,
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

  it("puts a partly done change under Building and a finished one under Ready", () => {
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
  it("names the issue count of an invalid change", () => {
    expect(changeStep(change({ valid: false, issueCount: 2 })).situation).toBe(
      "2 validation issues",
    );
  });

  it("offers the archive prompt once every task is done", () => {
    const step = changeStep(change({ completedTasks: 7, totalTasks: 7 }));
    expect(step.stage).toBe("Archive change");
    expect(step.prompt).toBe("/mate-archive-change acme-queue");
  });

  it("offers the apply prompt while building", () => {
    const step = changeStep(change({ completedTasks: 3, totalTasks: 7 }));
    expect(step.stage).toBe("Apply change");
    expect(step.situation).toBe("4 tasks left");
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
