import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DELIVERY_FILE,
  defaultDeliveryBranch,
  isPublishable,
  locateChangeDir,
  readDeliveryRecord,
  readDeliveryState,
  settleDelivery,
  unlinkedRecord,
  upsertDelivery,
  writeDeliveryRecord,
  type DeliveryRecord,
} from "./record";

let companion: string;

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-record-"));
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
});

const REPO = "acme/acme-app";
const OTHER = "acme/acme-docs";

describe("delivery record", () => {
  test("a missing file reads as null, which marks a legacy change", async () => {
    expect(await readDeliveryRecord(companion)).toBeNull();
    expect(settleDelivery(null).status).toBe("legacy");
  });

  test("writing then reading round-trips every field", async () => {
    const record: DeliveryRecord = upsertDelivery(unlinkedRecord("add-graph"), REPO, {
      branch: "feature/studio-graph",
      direct: false,
      pr: "https://github.com/acme/acme-app/pull/70",
      merge: {
        state: "merged",
        source: "forge",
        checkedAt: "2026-10-28T10:00:00.000Z",
        mergedAt: "2026-10-27T09:00:00Z",
        mergeCommit: "abc123",
        mergedBy: "octocat",
      },
    });
    await writeDeliveryRecord(companion, record);
    const raw = await fs.readFile(path.join(companion, DELIVERY_FILE), "utf8");
    expect(raw).toContain("feature/studio-graph");
    expect(await readDeliveryRecord(companion)).toEqual(record);
  });

  test("an unlinked record has no deliveries and settles as unlinked", () => {
    expect(settleDelivery(unlinkedRecord("x"))).toMatchObject({ status: "unlinked" });
  });

  test("the default branch is change/<change-name>", () => {
    expect(defaultDeliveryBranch("add-graph")).toBe("change/add-graph");
  });

  test("several changes sharing a branch each settle from the same merge", () => {
    const merged = {
      state: "merged" as const,
      source: "user" as const,
      checkedAt: "2026-10-28T10:00:00.000Z",
    };
    const records = ["a", "b", "c"].map((name) =>
      upsertDelivery(unlinkedRecord(name), REPO, { branch: "feature/studio-graph", merge: merged }),
    );
    expect(records.map((record) => settleDelivery(record).status)).toEqual([
      "merged",
      "merged",
      "merged",
    ]);
  });

  test("a change across two repositories settles only when both are merged", () => {
    const merged = { state: "merged" as const, source: "forge" as const, checkedAt: "t" };
    let record = upsertDelivery(unlinkedRecord("x"), REPO, { branch: "change/x", merge: merged });
    record = upsertDelivery(record, OTHER, { branch: "change/x" });
    expect(record.deliveries).toHaveLength(2);
    expect(settleDelivery(record)).toMatchObject({ status: "waiting", unsettled: [OTHER] });
    record = upsertDelivery(record, OTHER, { merge: merged });
    expect(settleDelivery(record).status).toBe("merged");
  });

  test("a scoped repository without a delivery keeps a merged change waiting", () => {
    const merged = { state: "merged" as const, source: "forge" as const, checkedAt: "t" };
    const record = upsertDelivery(unlinkedRecord("x"), REPO, { branch: "change/x", merge: merged });
    expect(settleDelivery(record, [REPO, OTHER])).toEqual({
      status: "waiting",
      unsettled: [OTHER],
      missing: [OTHER],
      unscoped: [],
    });
    const linked = upsertDelivery(record, OTHER, { notApplicable: "docs only" });
    expect(settleDelivery(linked, [REPO, OTHER]).status).toBe("merged");
  });

  test("scopes match a recorded repository case-insensitively", () => {
    const record = upsertDelivery(unlinkedRecord("x"), "Acme/Acme-App", { notApplicable: "spec" });
    expect(settleDelivery(record, [REPO]).status).toBe("not-applicable");
    expect(settleDelivery(record, [REPO]).unscoped).toEqual([]);
  });

  test("a delivery outside the scopes is reported with the spelling it likely means", () => {
    const record = upsertDelivery(unlinkedRecord("x"), "platform/api", { branch: "change/x" });
    expect(settleDelivery(record, ["acme/platform/api"])).toMatchObject({
      status: "waiting",
      missing: ["acme/platform/api"],
      unscoped: [{ repository: "platform/api", closest: "acme/platform/api" }],
    });
  });

  test("an unrelated delivery outside the scopes has no suggestion", () => {
    const record = upsertDelivery(unlinkedRecord("x"), "acme/web", {
      notApplicable: "old spelling",
    });
    expect(settleDelivery(record, ["acme/api"]).unscoped).toEqual([{ repository: "acme/web" }]);
  });

  test("without scopes no delivery is reported as unscoped", () => {
    const record = upsertDelivery(unlinkedRecord("x"), "acme/web", { branch: "change/x" });
    expect(settleDelivery(record).unscoped).toEqual([]);
    expect(settleDelivery(null, ["acme/api"]).unscoped).toEqual([]);
  });

  test("a not-applicable delivery needs no branch and is publishable", () => {
    const record = upsertDelivery(unlinkedRecord("x"), REPO, { notApplicable: "spec only" });
    expect(record.deliveries[0]).toEqual({ repository: REPO, notApplicable: "spec only" });
    expect(settleDelivery(record).status).toBe("not-applicable");
  });

  test("a closed unmerged result settles as dropped, an open one as waiting", () => {
    const at = { source: "user" as const, checkedAt: "t" };
    const dropped = upsertDelivery(unlinkedRecord("x"), REPO, {
      branch: "change/x",
      merge: { state: "closed-unmerged", ...at },
    });
    const open = upsertDelivery(unlinkedRecord("x"), REPO, {
      branch: "change/x",
      merge: { state: "open", ...at },
    });
    expect(settleDelivery(dropped).status).toBe("dropped");
    expect(settleDelivery(open).status).toBe("waiting");
  });

  test("setting a branch clears a not-applicable reason and a stale merge result", () => {
    let record = upsertDelivery(unlinkedRecord("x"), REPO, { notApplicable: "spec only" });
    record = upsertDelivery(record, REPO, {
      branch: "change/x",
      merge: { state: "open", source: "user", checkedAt: "t" },
    });
    record = upsertDelivery(record, REPO, { branch: "feature/y" });
    expect(record.deliveries[0]).toEqual({ repository: REPO, branch: "feature/y" });
  });

  test("merged, not-applicable, and legacy deliveries are publishable", () => {
    expect(isPublishable("merged")).toBe(true);
    expect(isPublishable("not-applicable")).toBe(true);
    expect(isPublishable("legacy")).toBe(true);
    for (const status of ["unlinked", "waiting", "dropped"] as const) {
      expect(isPublishable(status)).toBe(false);
    }
  });

  test("leaving direct delivery drops the direct flag", () => {
    let record = upsertDelivery(unlinkedRecord("x"), REPO, { branch: "main", direct: true });
    expect(record.deliveries[0]).toEqual({ repository: REPO, branch: "main", direct: true });
    record = upsertDelivery(record, REPO, { direct: false });
    expect(record.deliveries[0]).toEqual({ repository: REPO, branch: "main" });
  });

  test("switching between direct and PR delivery on one branch drops the merge result and PR", () => {
    let record = upsertDelivery(unlinkedRecord("x"), REPO, {
      branch: "release/x",
      direct: true,
      merge: { state: "merged", source: "user", checkedAt: "t" },
    });
    record = upsertDelivery(record, REPO, { branch: "release/x", direct: false });
    expect(record.deliveries[0]).toEqual({ repository: REPO, branch: "release/x" });
    expect(settleDelivery(record).status).toBe("waiting");

    record = upsertDelivery(record, REPO, {
      pr: "https://github.com/acme/acme/pull/1",
      merge: { state: "merged", source: "forge", checkedAt: "t" },
    });
    record = upsertDelivery(record, REPO, { branch: "release/x", direct: true });
    expect(record.deliveries[0]).toEqual({ repository: REPO, branch: "release/x", direct: true });
  });

  test("a repository differing only by case edits the same delivery and keeps its spelling", () => {
    let record = upsertDelivery(unlinkedRecord("x"), "Acme/Api", { branch: "change/x" });
    record = upsertDelivery(record, "acme/api", {
      merge: { state: "merged", source: "user", checkedAt: "t" },
    });
    expect(record.deliveries).toHaveLength(1);
    expect(record.deliveries[0].repository).toBe("Acme/Api");
    expect(settleDelivery(record).status).toBe("merged");
  });

  test("a malformed file is reported, never silently treated as legacy", async () => {
    await fs.writeFile(path.join(companion, DELIVERY_FILE), "deliveries: 7\n");
    await expect(readDeliveryRecord(companion)).rejects.toThrow(/delivery.yaml/);
  });

  test("a base from an earlier version is ignored on read and dropped on the next write", async () => {
    await fs.writeFile(
      path.join(companion, DELIVERY_FILE),
      `deliveries:\n  - repository: ${REPO}\n    branch: main\n    direct: true\n    base: abc123\n`,
    );
    const record = await readDeliveryRecord(companion);
    expect(record?.deliveries[0]).toEqual({ repository: REPO, branch: "main", direct: true });
    await writeDeliveryRecord(companion, record!);
    expect(await fs.readFile(path.join(companion, DELIVERY_FILE), "utf8")).not.toContain("base");
  });
});

describe("locateChangeDir", () => {
  test("finds an active change, then the newest archive of that name", async () => {
    const changes = path.join(companion, "openspec", "changes");
    await fs.mkdir(path.join(changes, "archive", "2026-01-01-x"), { recursive: true });
    await fs.mkdir(path.join(changes, "archive", "2026-02-01-x"), { recursive: true });
    await fs.mkdir(path.join(changes, "archive", "2026-03-01-xy"), { recursive: true });
    expect(await locateChangeDir(companion, "x")).toEqual({
      dir: path.join(changes, "archive", "2026-02-01-x"),
      archived: true,
    });

    await fs.mkdir(path.join(changes, "x"));
    expect(await locateChangeDir(companion, "x")).toEqual({
      dir: path.join(changes, "x"),
      archived: false,
    });
    expect(await locateChangeDir(companion, "2026-01-01-x")).toEqual({
      dir: path.join(changes, "archive", "2026-01-01-x"),
      archived: true,
    });
    expect(await locateChangeDir(companion, "missing")).toBeNull();
  });

  test("a name that is not one path segment resolves to nothing", async () => {
    await fs.mkdir(path.join(companion, "openspec", "changes", "archive"), { recursive: true });
    for (const name of ["../..", "..", ".", "a/b", "../changes", ""]) {
      expect(await locateChangeDir(companion, name)).toBeNull();
    }
  });

  test("a record written to an active change is still read after the directory moves", async () => {
    const active = path.join(companion, "openspec", "changes", "x");
    await fs.mkdir(active, { recursive: true });
    await writeDeliveryRecord(active, upsertDelivery(unlinkedRecord("x"), REPO, { branch: "b" }));
    const archived = path.join(companion, "openspec", "changes", "archive", "2026-10-28-x");
    await fs.mkdir(path.dirname(archived), { recursive: true });
    await fs.rename(active, archived);
    expect((await readDeliveryRecord(archived))?.deliveries[0].branch).toBe("b");
  });
});

describe("readDeliveryState", () => {
  test("reports a damaged record as unlinked with its error", async () => {
    await fs.writeFile(path.join(companion, DELIVERY_FILE), "deliveries: nope\n");
    const state = await readDeliveryState(companion);
    expect(state.status).toBe("unlinked");
    expect(state.record).toBeNull();
    expect(state.error).toContain(DELIVERY_FILE);
  });

  test("settles a missing record as legacy", async () => {
    expect(await readDeliveryState(companion)).toEqual({
      status: "legacy",
      unsettled: [],
      missing: [],
      unscoped: [],
      record: null,
    });
  });

  test("settles against the repositories the proposal and delta specs are scoped to", async () => {
    await fs.writeFile(
      path.join(companion, "proposal.md"),
      `---\ntype: change-proposal\nscopes:\n  - repository: ${REPO}\n    area: .\n---\n\n## Why\n`,
    );
    await fs.mkdir(path.join(companion, "specs", "acme"), { recursive: true });
    await fs.writeFile(
      path.join(companion, "specs", "acme", "spec.md"),
      `<!-- mate:delta\nchange: x\ncapability: acme\nscopes:\n  - repository: ${OTHER}\n    area: docs\n-->\n\n## ADDED Requirements\n`,
    );
    const merged = { state: "merged" as const, source: "forge" as const, checkedAt: "t" };
    await writeDeliveryRecord(
      companion,
      upsertDelivery(unlinkedRecord("x"), REPO, { branch: "change/x", merge: merged }),
    );
    const state = await readDeliveryState(companion);
    expect(state.status).toBe("waiting");
    expect(state.missing).toEqual([OTHER]);
    expect(isPublishable(state.status)).toBe(false);
  });
});
