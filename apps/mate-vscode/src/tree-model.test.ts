import { describe, expect, test } from "bun:test";

import { buildPairingSnapshot } from "./pairing-snapshot";
import type { WorkspaceInventoryV1, WorkspaceInventoryPairing } from "./schema";
import {
  buildCompanionRoots,
  buildWorkingRepositoryRoots,
  childrenOfCompanionGroup,
  childrenOfWorkingRepository,
  isPairingLaunchable,
  isPairingOpenable,
  pairingContextValue,
  rootNodesForState,
} from "./tree-model";

const READY_PAIRING: WorkspaceInventoryPairing = {
  companionPath: "/companions/a",
  repository: { id: "app", path: "/repos/app" },
  health: "ready",
  ambiguous: false,
};

const MISSING_REPO_PAIRING: WorkspaceInventoryPairing = {
  companionPath: "/companions/a",
  repository: { id: "other", path: "/repos/gone" },
  health: "missing-repository",
  ambiguous: false,
};

describe("pairingContextValue", () => {
  test("a ready, trusted pairing is open and launchable", () => {
    const value = pairingContextValue(READY_PAIRING, true);

    expect(value).toContain("pairing-open");
    expect(value).toContain("pairing-repo-available");
    expect(value).toContain("pairing-launchable");
  });

  test("a ready pairing in an untrusted window is open but not launchable", () => {
    const value = pairingContextValue(READY_PAIRING, false);

    expect(value).toContain("pairing-open");
    expect(value).not.toContain("pairing-launchable");
  });

  test("a pairing with a missing repository is neither open nor launchable", () => {
    const value = pairingContextValue(MISSING_REPO_PAIRING, true);

    expect(value).not.toContain("pairing-open");
    expect(value).not.toContain("pairing-launchable");
    expect(value).not.toContain("pairing-repo-available");
    expect(value).toBe("pairing");
  });
});

describe("isPairingOpenable / isPairingLaunchable", () => {
  test("ready pairing is openable regardless of trust", () => {
    expect(isPairingOpenable(READY_PAIRING)).toBe(true);
  });

  test("only a ready pairing in a trusted window is launchable", () => {
    expect(isPairingLaunchable(READY_PAIRING, true)).toBe(true);
    expect(isPairingLaunchable(READY_PAIRING, false)).toBe(false);
    expect(isPairingLaunchable(MISSING_REPO_PAIRING, true)).toBe(false);
  });
});

describe("tree roots", () => {
  test("buildWorkingRepositoryRoots returns an empty node for an empty inventory", () => {
    const snapshot = buildPairingSnapshot({ schemaVersion: 1, companions: [], pairings: [] });

    expect(buildWorkingRepositoryRoots(snapshot)).toEqual([{ kind: "empty" }]);
  });

  test("buildCompanionRoots returns an empty node for an empty inventory", () => {
    const snapshot = buildPairingSnapshot({ schemaVersion: 1, companions: [], pairings: [] });

    expect(buildCompanionRoots(snapshot)).toEqual([{ kind: "empty" }]);
  });

  test("buildWorkingRepositoryRoots yields one node per distinct repository id", () => {
    const inventory: WorkspaceInventoryV1 = {
      schemaVersion: 1,
      companions: [{ path: "/companions/a", health: "ready" }],
      pairings: [READY_PAIRING, MISSING_REPO_PAIRING],
    };
    const snapshot = buildPairingSnapshot(inventory);

    const roots = buildWorkingRepositoryRoots(snapshot);

    expect(roots).toHaveLength(2);
    expect(roots.map((r) => (r as { repositoryId: string }).repositoryId)).toEqual([
      "app",
      "other",
    ]);
  });

  test("childrenOfWorkingRepository yields a pairing leaf per companion", () => {
    const inventory: WorkspaceInventoryV1 = {
      schemaVersion: 1,
      companions: [{ path: "/companions/a", health: "ready" }],
      pairings: [READY_PAIRING],
    };
    const snapshot = buildPairingSnapshot(inventory);
    const [root] = buildWorkingRepositoryRoots(snapshot);

    const children = childrenOfWorkingRepository(root as never, true);

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ kind: "pairing", description: "/companions/a" });
  });

  test("childrenOfCompanionGroup yields a pairing leaf per working repository", () => {
    const inventory: WorkspaceInventoryV1 = {
      schemaVersion: 1,
      companions: [{ path: "/companions/a", health: "ready" }],
      pairings: [READY_PAIRING, MISSING_REPO_PAIRING],
    };
    const snapshot = buildPairingSnapshot(inventory);
    const [root] = buildCompanionRoots(snapshot);

    const children = childrenOfCompanionGroup(root as never, true);

    expect(children).toHaveLength(2);
    expect(children.map((c) => (c as { description: string }).description)).toEqual([
      "/repos/app",
      "/repos/gone",
    ]);
  });
});

describe("rootNodesForState", () => {
  test("loading state yields a loading node", () => {
    expect(rootNodesForState({ status: "loading" }, "working-repository")).toEqual([
      { kind: "loading" },
    ]);
  });

  test("unavailable state yields an unavailable node", () => {
    expect(rootNodesForState({ status: "unavailable" }, "companion")).toEqual([
      { kind: "unavailable" },
    ]);
  });

  test("error state carries the message through", () => {
    expect(rootNodesForState({ status: "error", message: "boom" }, "working-repository")).toEqual([
      { kind: "error", message: "boom" },
    ]);
  });

  test("ready state delegates to the requested grouping", () => {
    const inventory: WorkspaceInventoryV1 = {
      schemaVersion: 1,
      companions: [{ path: "/companions/a", health: "ready" }],
      pairings: [READY_PAIRING],
    };
    const snapshot = buildPairingSnapshot(inventory);

    const byRepo = rootNodesForState({ status: "ready", snapshot }, "working-repository");
    const byCompanion = rootNodesForState({ status: "ready", snapshot }, "companion");

    expect(byRepo[0]).toMatchObject({ kind: "working-repository", repositoryId: "app" });
    expect(byCompanion[0]).toMatchObject({
      kind: "companion-group",
      companionPath: "/companions/a",
    });
  });
});
