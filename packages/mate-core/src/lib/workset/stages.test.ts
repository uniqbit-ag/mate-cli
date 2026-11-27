import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorksetRecord } from "./record";
import { changeStage } from "./stage";
import {
  type ActiveChangeState,
  collectChangeFacts,
  readWorksetStages,
  type WorksetStageSources,
} from "./stages";

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
    activeDelivery: async () => ({ submitted: false, status: "waiting" }),
    submittedChanges: async () => [],
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
        problems: [{ path: ".mate/scratchpad/x.yaml", reason: "bad" }],
      }),
      activeChanges: counted,
      publishedAnchors: counted,
      archiveAnchors: counted,
      archiveMergeSettled: async () => {
        calls++;
        return true;
      },
    });
    expect(read).toEqual({
      worksets: [],
      problems: [{ path: ".mate/scratchpad/x.yaml", reason: "bad" }],
    });
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

  describe("a submitted change, still active", () => {
    const submitted = (
      local: "waiting" | "merged",
      pending: Partial<WorksetStageSources> = {},
    ): Partial<WorksetStageSources> => ({
      activeDelivery: async (_companion, change) => ({
        submitted: change === "acme-applying",
        status: local,
      }),
      ...pending,
    });
    const linked = [workset("acme-a", ["acme-applying"])];

    test("waits for merge, then for publication", async () => {
      expect(await stagesOf(linked, submitted("waiting"))).toEqual([["acme-a", "merge-wait", []]]);
      expect(await stagesOf(linked, submitted("merged"))).toEqual([["acme-a", "publish", []]]);
    });

    test("a merge recorded on the pending branch only is publish", async () => {
      const pending = submitted("waiting", {
        submittedChanges: async () => [{ name: "acme-applying", delivery: { status: "merged" } }],
      });
      expect(await stagesOf(linked, pending)).toEqual([["acme-a", "publish", []]]);
    });

    test("an unreadable pending branch falls back to the local record", async () => {
      const unreadable = {
        submittedChanges: async () => {
          throw new Error("no pending branch");
        },
      };
      expect(await stagesOf(linked, submitted("merged", unreadable))).toEqual([
        ["acme-a", "publish", []],
      ]);
      expect(await stagesOf(linked, submitted("waiting", unreadable))).toEqual([
        ["acme-a", "merge-wait", []],
      ]);
    });

    test("the pending branch is not read while nothing is submitted", async () => {
      let reads = 0;
      await stagesOf(linked, {
        submittedChanges: async () => {
          reads++;
          return [];
        },
      });
      expect(reads).toBe(0);
    });
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

describe("submitted changes", () => {
  let companion: string;

  beforeEach(async () => {
    companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-stages-"));
  });

  afterEach(() => fs.rm(companion, { recursive: true, force: true }));

  test("a change its record marks submitted waits for its merge", async () => {
    const dir = path.join(companion, "openspec", "changes", "acme-applying");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "delivery.yaml"),
      "version: 1\nchange: acme-applying\nstate: submitted\ndeliveries: []\n",
    );
    const facts = await collectChangeFacts(
      companion,
      [{ name: "acme-applying", kind: "active" }],
      [{ ...planned, name: "acme-applying", completedTasks: 2 }],
      new Set(),
    );
    expect(changeStage(facts.get("acme-applying")!)).toBe("merge-wait");
  });

  test("a change only the pending branch holds waits for its merge", async () => {
    const facts = await collectChangeFacts(
      companion,
      [{ name: "acme-teammate", kind: "active" }],
      [],
      new Set(),
      undefined,
      new Set(["acme-teammate"]),
    );
    expect(changeStage(facts.get("acme-teammate")!)).toBe("merge-wait");
  });
});
