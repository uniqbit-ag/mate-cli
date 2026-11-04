import { describe, expect, test } from "bun:test";

import type { WorksetRecord } from "./record";
import { type ActiveChangeState, readWorksetStages, type WorksetStageSources } from "./stages";

const workset = (
  id: string,
  changes: string[],
  stage: WorksetRecord["stage"] = "ready",
): WorksetRecord => ({
  id,
  title: id,
  intent: "",
  repositories: ["acme/web"],
  changes,
  stage,
  createdAt: "",
  extra: {},
});

const planned: ActiveChangeState = {
  name: "acme-planned",
  artifacts: [
    { id: "specs", status: "done" },
    { id: "tasks", status: "done" },
  ],
};

function sources(overrides: Partial<WorksetStageSources> = {}): WorksetStageSources {
  return {
    activeChanges: async () => [
      planned,
      { ...planned, name: "acme-applying", completedTasks: 2 },
      { name: "acme-drafting", artifacts: [{ id: "specs", status: "ready" }] },
    ],
    publishedAnchors: async () => ["2026-10-01-acme-shipped"],
    archiveAnchors: async () => ["2026-10-01-acme-shipped", "2026-10-02-acme-merged"],
    archiveMergeSettled: async (_companion, anchor) => anchor !== "2026-10-03-acme-unmerged",
    ...overrides,
  };
}

async function stagesOf(records: WorksetRecord[], overrides: Partial<WorksetStageSources> = {}) {
  const { worksets } = await readWorksetStages(
    "/companions/acme",
    sources({ readWorksets: async () => ({ worksets: records, problems: [] }), ...overrides }),
  );
  return worksets.map(({ record, derived }) => [record.id, derived.stage, derived.problems]);
}

describe("reading Workset stages", () => {
  test("a companion without Worksets calls no source", async () => {
    let calls = 0;
    const counted = async () => {
      calls++;
      return [];
    };
    const read = await readWorksetStages("/companions/acme", {
      readWorksets: async () => ({
        worksets: [],
        problems: [{ path: "worksets/x.yaml", reason: "bad" }],
      }),
      activeChanges: counted,
      publishedAnchors: counted,
      archiveAnchors: counted,
      archiveMergeSettled: async () => {
        calls++;
        return true;
      },
    });
    expect(read).toEqual({ worksets: [], problems: [{ path: "worksets/x.yaml", reason: "bad" }] });
    expect(calls).toBe(0);
  });

  test("active changes give propose, the Human Reviews or apply", async () => {
    expect(
      await stagesOf([
        workset("acme-a", ["acme-drafting"]),
        workset("acme-b", ["acme-planned"]),
        workset("acme-c", ["acme-applying"]),
      ]),
    ).toEqual([
      ["acme-a", "propose", []],
      ["acme-b", "human-review", []],
      ["acme-c", "apply", []],
    ]);
  });

  test("archives give waiting for merge, publish or Done", async () => {
    expect(
      await stagesOf(
        [
          workset("acme-a", ["acme-unmerged"]),
          workset("acme-b", ["acme-merged"]),
          workset("acme-c", ["acme-shipped"]),
        ],
        {
          archiveAnchors: async () => [
            "2026-10-01-acme-shipped",
            "2026-10-02-acme-merged",
            "2026-10-03-acme-unmerged",
          ],
        },
      ),
    ).toEqual([
      ["acme-a", "merge-wait", []],
      ["acme-b", "publish", []],
      ["acme-c", "done", []],
    ]);
  });

  test("a Workset sits at its least advanced change", async () => {
    expect(await stagesOf([workset("acme-a", ["acme-shipped", "acme-planned"])])).toEqual([
      ["acme-a", "human-review", []],
    ]);
  });

  test("missing and doubly claimed changes become problems", async () => {
    expect(
      await stagesOf([
        workset("acme-a", ["acme-gone"]),
        workset("acme-b", ["acme-planned"]),
        workset("acme-c", ["acme-planned"]),
      ]),
    ).toEqual([
      ["acme-a", "propose", ["acme-gone is neither active nor archived"]],
      ["acme-b", "propose", ["acme-planned is also listed by acme-c"]],
      ["acme-c", "propose", ["acme-planned is also listed by acme-b"]],
    ]);
  });

  test("a Workset with no change keeps its record's stage", async () => {
    expect(await stagesOf([workset("acme-a", [], "explore")])).toEqual([["acme-a", "explore", []]]);
  });
});
