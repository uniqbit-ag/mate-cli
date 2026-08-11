import { describe, expect, test } from "bun:test";

import { childrenOfOpenSpecCompanionGroup, rootNodesForOpenSpecState } from "./openspec-tree-model";

describe("rootNodesForOpenSpecState", () => {
  test("loading state yields a loading node", () => {
    expect(rootNodesForOpenSpecState({ status: "loading" })).toEqual([{ kind: "loading" }]);
  });

  test("unavailable state yields an unavailable node", () => {
    expect(rootNodesForOpenSpecState({ status: "unavailable" })).toEqual([{ kind: "unavailable" }]);
  });

  test("error state carries the message through", () => {
    expect(rootNodesForOpenSpecState({ status: "error", message: "boom" })).toEqual([
      { kind: "error", message: "boom" },
    ]);
  });

  test("ready state with no companions yields an empty node", () => {
    expect(rootNodesForOpenSpecState({ status: "ready", companions: [] })).toEqual([
      { kind: "empty" },
    ]);
  });

  test("ready state yields one companion-group node per companion", () => {
    const companions = [
      { companionPath: "/companions/a", changes: [] },
      { companionPath: "/companions/b", changes: [] },
    ];

    expect(rootNodesForOpenSpecState({ status: "ready", companions })).toEqual([
      { kind: "companion-group", ...companions[0] },
      { kind: "companion-group", ...companions[1] },
    ]);
  });
});

describe("childrenOfOpenSpecCompanionGroup", () => {
  test("yields an empty node for a companion with no active changes", () => {
    expect(
      childrenOfOpenSpecCompanionGroup({ companionPath: "/companions/a", changes: [] }),
    ).toEqual([{ kind: "empty" }]);
  });

  test("yields one change leaf per active change, tagged with the owning companion path", () => {
    const changes = [
      { name: "add-foo", completedTasks: 1, totalTasks: 4, status: "in-progress" },
      { name: "add-bar", completedTasks: 3, totalTasks: 3, status: "complete" },
    ];

    expect(childrenOfOpenSpecCompanionGroup({ companionPath: "/companions/a", changes })).toEqual([
      { kind: "change", companionPath: "/companions/a", ...changes[0] },
      { kind: "change", companionPath: "/companions/a", ...changes[1] },
    ]);
  });
});
