import { describe, expect, test } from "bun:test";

import {
  buildPairingSnapshot,
  projectByCompanion,
  projectByWorkingRepository,
} from "./pairing-snapshot";
import type { WorkspaceInventoryV1 } from "./schema";

const INVENTORY: WorkspaceInventoryV1 = {
  schemaVersion: 1,
  companions: [
    { path: "/companions/a", health: "ready" },
    { path: "/companions/b", health: "ready" },
    { path: "/companions/empty", health: "ready" },
  ],
  pairings: [
    {
      companionPath: "/companions/a",
      repository: { id: "app", path: "/repos/app" },
      health: "ready",
      ambiguous: true,
    },
    {
      companionPath: "/companions/b",
      repository: { id: "app", path: "/repos/app" },
      health: "ready",
      ambiguous: true,
    },
    {
      companionPath: "/companions/a",
      repository: { id: "other", path: "/repos/other" },
      health: "missing-repository",
      ambiguous: false,
    },
  ],
};

describe("buildPairingSnapshot", () => {
  test("freezes companions and pairings", () => {
    const snapshot = buildPairingSnapshot(INVENTORY);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.companions)).toBe(true);
    expect(Object.isFrozen(snapshot.pairings)).toBe(true);
    expect(Object.isFrozen(snapshot.pairings[0])).toBe(true);
  });

  test("does not mutate the source inventory objects", () => {
    const snapshot = buildPairingSnapshot(INVENTORY);

    expect(snapshot.companions[0]).toEqual(INVENTORY.companions[0]!);
    expect(snapshot.companions[0]).not.toBe(INVENTORY.companions[0]);
  });
});

describe("projectByWorkingRepository", () => {
  test("groups every pairing for a repo linked from multiple companions under one group", () => {
    const snapshot = buildPairingSnapshot(INVENTORY);

    const groups = projectByWorkingRepository(snapshot);

    expect(groups).toHaveLength(2);
    const app = groups.find((g) => g.repositoryId === "app");
    expect(app?.pairings).toHaveLength(2);
    expect(app?.pairings.map((p) => p.companionPath).sort()).toEqual([
      "/companions/a",
      "/companions/b",
    ]);
  });

  test("sorts groups deterministically by repository id", () => {
    const snapshot = buildPairingSnapshot(INVENTORY);

    const groups = projectByWorkingRepository(snapshot);

    expect(groups.map((g) => g.repositoryId)).toEqual(["app", "other"]);
  });
});

describe("projectByCompanion", () => {
  test("includes a companion with zero pairings", () => {
    const snapshot = buildPairingSnapshot(INVENTORY);

    const groups = projectByCompanion(snapshot);

    const empty = groups.find((g) => g.companionPath === "/companions/empty");
    expect(empty).toBeDefined();
    expect(empty?.pairings).toEqual([]);
  });

  test("lists every working repository linked from one companion", () => {
    const snapshot = buildPairingSnapshot(INVENTORY);

    const groups = projectByCompanion(snapshot);

    const companionA = groups.find((g) => g.companionPath === "/companions/a");
    expect(companionA?.pairings.map((p) => p.repository.id).sort()).toEqual(["app", "other"]);
  });

  test("sorts groups deterministically by companion path", () => {
    const snapshot = buildPairingSnapshot(INVENTORY);

    const groups = projectByCompanion(snapshot);

    expect(groups.map((g) => g.companionPath)).toEqual([
      "/companions/a",
      "/companions/b",
      "/companions/empty",
    ]);
  });
});
