import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DELIVERY_FILE,
  defaultDeliveryBranch,
  isJiraKey,
  isPublishable,
  legacyDeliveryBranch,
  legacyDeliveryWarning,
  normalizeJiraKey,
  readDeliveryRecord,
  readDeliveryState,
  readOrUnlinkedRecord,
  recordStep,
  settleDelivery,
  ticketCandidateOf,
  unlinkedRecord,
  upsertDelivery,
  withoutStage,
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
        source: "git",
        checkedAt: "2026-10-28T10:00:00.000Z",
        mergedAt: "2026-10-27T09:00:00Z",
        mergeCommit: "abc123",
      },
    });
    await writeDeliveryRecord(companion, record);
    const raw = await fs.readFile(path.join(companion, DELIVERY_FILE), "utf8");
    expect(raw).toContain("feature/studio-graph");
    expect(await readDeliveryRecord(companion)).toEqual(record);
  });

  test("the submission state and block round-trip, written before the deliveries", async () => {
    const record: DeliveryRecord = {
      ...unlinkedRecord("acme-login"),
      state: "submitted",
      blocked: {
        reason: 'acme-auth "Login" changed since the delta base',
        paths: ["openspec/specs/acme-auth/spec.md"],
        since: "2026-11-15T10:00:00.000Z",
        tip: "a".repeat(40),
      },
    };
    await writeDeliveryRecord(companion, record);
    const raw = await fs.readFile(path.join(companion, DELIVERY_FILE), "utf8");
    expect(raw.indexOf("state: submitted")).toBeLessThan(raw.indexOf("deliveries:"));
    expect(await readDeliveryRecord(companion)).toEqual(record);
  });

  test("an unknown state or a block without a reason is malformed", async () => {
    const file = path.join(companion, DELIVERY_FILE);
    await fs.writeFile(file, "version: 1\nchange: acme\ndeliveries: []\nstate: merged\n");
    await expect(readDeliveryRecord(companion)).rejects.toThrow("state must be one of");
    await fs.writeFile(
      file,
      "version: 1\nchange: acme\ndeliveries: []\nblocked:\n  paths: []\n  since: 2026-11-15T10:00:00.000Z\n",
    );
    await expect(readDeliveryRecord(companion)).rejects.toThrow("blocked.reason");
    await fs.writeFile(
      file,
      "version: 1\nchange: acme\ndeliveries: []\nblocked:\n  reason: acme\n  since: 2026-11-15T10:00:00.000Z\n  tip: main\n",
    );
    await expect(readDeliveryRecord(companion)).rejects.toThrow("blocked.tip");
  });

  test("an unlinked record has no deliveries and settles as unlinked", () => {
    expect(settleDelivery(unlinkedRecord("x"))).toMatchObject({ status: "unlinked" });
  });

  test("the default branch names the Workset; legacy names remain available", () => {
    expect(defaultDeliveryBranch("acme-fix")).toBe("workset/acme-fix");
    expect(legacyDeliveryBranch("acme-fix")).toBe("change/acme-fix");
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

  test("a different PR drops the merge result; the same PR keeps it", () => {
    const merged = upsertDelivery(unlinkedRecord("x"), REPO, {
      branch: "change/x",
      pr: "https://github.com/acme/acme-app/pull/3",
      merge: { state: "merged", source: "forge", checkedAt: "t" },
    });
    const same = upsertDelivery(merged, REPO, { pr: "https://github.com/acme/acme-app/pull/3" });
    expect(same.deliveries[0].merge?.state).toBe("merged");
    const other = upsertDelivery(merged, REPO, { pr: "https://github.com/acme/acme-app/pull/7" });
    expect(other.deliveries[0]).toEqual({
      repository: REPO,
      branch: "change/x",
      pr: "https://github.com/acme/acme-app/pull/7",
    });
    expect(settleDelivery(other).status).toBe("waiting");
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

  test("a git result and a recorded head round-trip; a record without head stays valid", async () => {
    const head = "a".repeat(40);
    const record = upsertDelivery(unlinkedRecord("x"), REPO, {
      branch: "change/x",
      head,
      merge: { state: "merged", source: "git", checkedAt: "2026-11-04T10:00:00.000Z" },
    });
    await writeDeliveryRecord(companion, record);
    expect(await readDeliveryRecord(companion)).toEqual(record);

    await fs.writeFile(
      path.join(companion, DELIVERY_FILE),
      `deliveries:\n  - repository: ${REPO}\n    branch: change/x\n`,
    );
    expect((await readDeliveryRecord(companion))?.deliveries[0].head).toBeUndefined();
  });

  test("a head that is not a full commit id reads as absent", async () => {
    for (const head of ["abc123", "--output=/tmp/acme"]) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time
      await fs.writeFile(
        path.join(companion, DELIVERY_FILE),
        `deliveries:\n  - repository: ${REPO}\n    branch: b\n    head: "${head}"\n`,
      );
      // oxlint-disable-next-line no-await-in-loop -- same file
      expect((await readDeliveryRecord(companion))?.deliveries[0]).toEqual({
        repository: REPO,
        branch: "b",
      });
    }
  });

  test("the unpushed mark is read, written, and dropped with a new branch", async () => {
    const head = "a".repeat(40);
    await fs.writeFile(
      path.join(companion, DELIVERY_FILE),
      `deliveries:\n  - repository: ${REPO}\n    branch: b\n    head: ${head}\n    unpushed: true\n`,
    );
    const record = await readDeliveryRecord(companion);
    expect(record?.deliveries[0]).toEqual({ repository: REPO, branch: "b", head, unpushed: true });
    await writeDeliveryRecord(companion, record!);
    expect((await readDeliveryRecord(companion))?.deliveries[0].unpushed).toBe(true);

    expect(upsertDelivery(record!, REPO, { unpushed: false }).deliveries[0]).toEqual({
      repository: REPO,
      branch: "b",
      head,
    });
    expect(upsertDelivery(record!, REPO, { branch: "c" }).deliveries[0]).toEqual({
      repository: REPO,
      branch: "c",
    });
  });

  test("an earlier Mate's forge result parses, counts as merged, and loses mergedBy on write", async () => {
    await fs.writeFile(
      path.join(companion, DELIVERY_FILE),
      `state: submitted\ndeliveries:\n  - repository: ${REPO}\n    branch: change/x\n    merge:\n      state: merged\n      source: forge\n      mergedBy: acme-bot\n      checkedAt: "2026-10-28T10:00:00.000Z"\n`,
    );
    const record = await readDeliveryRecord(companion);
    expect(record?.deliveries[0].merge).toEqual({
      state: "merged",
      source: "forge",
      checkedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(isPublishable(settleDelivery(record).status)).toBe(true);
    await writeDeliveryRecord(companion, record!);
    const raw = await fs.readFile(path.join(companion, DELIVERY_FILE), "utf8");
    expect(raw).toContain("source: forge");
    expect(raw).not.toContain("mergedBy");
  });

  test("a new branch drops the old head", () => {
    const linked = upsertDelivery(unlinkedRecord("x"), REPO, { branch: "a", head: "b".repeat(40) });
    expect(upsertDelivery(linked, REPO, { branch: "c" }).deliveries[0].head).toBeUndefined();
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

describe("delivery records across archive", () => {
  test("a record written to an active change is still read after the directory moves", async () => {
    const active = path.join(companion, "openspec", "changes", "x");
    await fs.mkdir(active, { recursive: true });
    await writeDeliveryRecord(active, upsertDelivery(unlinkedRecord("x"), REPO, { branch: "b" }));
    const archived = path.join(companion, "openspec", "changes", "archive", "2026-10-28-x");
    await fs.mkdir(path.dirname(archived), { recursive: true });
    await fs.rename(active, archived);
    expect((await readDeliveryRecord(archived))?.deliveries[0].branch).toBe("b");
  });

  test("an archived record without a change field is named after the change, not the anchor", async () => {
    const archived = path.join(companion, "2026-10-28-acme");
    await fs.mkdir(archived);
    await fs.writeFile(path.join(archived, DELIVERY_FILE), `deliveries: []\n`);
    expect((await readDeliveryRecord(archived))?.change).toBe("acme");
  });

  test("a renamed change's record takes the requested name, not the stale one in the file", async () => {
    await writeDeliveryRecord(companion, unlinkedRecord("acme"));
    expect((await readOrUnlinkedRecord(companion, "acme-v2")).change).toBe("acme-v2");
    expect((await readOrUnlinkedRecord(companion, "2026-10-28-acme-v2")).change).toBe("acme-v2");
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

describe("tickets", () => {
  test("a canary record with ticket and skipped parses, and the next write drops both", async () => {
    await fs.writeFile(
      path.join(companion, DELIVERY_FILE),
      "version: 1\nchange: x\nticket: abc123\nskipped: true\ndeliveries: []\n",
    );
    const record = await readDeliveryRecord(companion);
    expect(record).toEqual(unlinkedRecord("x"));
    await writeDeliveryRecord(companion, record!);
    const source = await fs.readFile(path.join(companion, DELIVERY_FILE), "utf8");
    expect(source).toBe("version: 1\nchange: x\ndeliveries: []\n");
  });

  test("a record without any delivery settles unlinked, ticket or not", async () => {
    await fs.writeFile(
      path.join(companion, DELIVERY_FILE),
      "version: 1\nchange: x\nticket: ABC-123\ndeliveries: []\n",
    );
    const record = await readDeliveryRecord(companion);
    expect(settleDelivery(record).status).toBe("unlinked");
    expect(isPublishable(settleDelivery(record).status)).toBe(false);
    expect(legacyDeliveryWarning("2026-11-05-x")).toContain("has no delivery.yaml");
  });

  test("the computed branch carries a given ticket", () => {
    expect(defaultDeliveryBranch("acme-fix", "ABC-123")).toBe("workset/ABC-123-acme-fix");
    expect(defaultDeliveryBranch("acme-fix", null)).toBe("workset/acme-fix");
  });

  test("Jira keys in any case", () => {
    expect(isJiraKey("ABC-123")).toBe(true);
    expect(isJiraKey("A1B-9")).toBe(true);
    expect(isJiraKey("abc-123")).toBe(true);
    expect(normalizeJiraKey("abc-123")).toBe("ABC-123");
    for (const value of ["ABC123", "abc123", "A-1", "ABC-", "ABC-12x"]) {
      expect(isJiraKey(value)).toBe(false);
    }
  });

  test("a branch name yields a candidate only for one distinct key", () => {
    expect(ticketCandidateOf("feature/acme")).toBeNull();
    expect(ticketCandidateOf("feature/ABC-123-retry")).toBe("ABC-123");
    expect(ticketCandidateOf("feature/abc-123-retry")).toBe("ABC-123");
    expect(ticketCandidateOf("ABC-123/abc-123-retry")).toBe("ABC-123");
    expect(ticketCandidateOf("ABC-1-ABC-2-merge")).toBeNull();
    expect(ticketCandidateOf("workset/ABC-123-acme-fix")).toBe("ABC-123");
  });
});

describe("recorded steps", () => {
  const file = (): string => path.join(companion, DELIVERY_FILE);

  test("a step is recorded with a write limited to its stage's entry, before deliveries", async () => {
    const head = `version: 1
change: acme-fix
# kept as written
specBase: ${"a".repeat(40)}
`;
    const deliveries = `deliveries:
  - repository: ${REPO}
    branch: workset/acme-fix
`;
    await fs.writeFile(file(), `${head}${deliveries}`);

    await recordStep(companion, "acme-fix", "apply", "mate-apply-change");

    expect(await fs.readFile(file(), "utf8")).toBe(
      `${head}stages:\n  apply:\n    - mate-apply-change\n${deliveries}`,
    );
    expect((await readDeliveryRecord(companion))?.stages).toEqual({
      apply: ["mate-apply-change"],
    });
  });

  test("steps join in the order recorded and a recorded skill changes nothing", async () => {
    await writeDeliveryRecord(companion, unlinkedRecord("acme-fix"));
    await recordStep(companion, "acme-fix", "apply", "mate-apply-change");
    await recordStep(companion, "acme-fix", "apply", "acme-verify");
    await recordStep(companion, "acme-fix", "build", "acme-build");
    const written = await fs.readFile(file(), "utf8");

    await recordStep(companion, "acme-fix", "apply", "mate-apply-change");

    expect(await fs.readFile(file(), "utf8")).toBe(written);
    expect((await readDeliveryRecord(companion))?.stages).toEqual({
      apply: ["mate-apply-change", "acme-verify"],
      build: ["acme-build"],
    });
  });

  test("concurrent steps of one stage are all recorded", async () => {
    await writeDeliveryRecord(companion, unlinkedRecord("acme-fix"));
    const skills = ["acme-verify", "acme-lint", "acme-test", "acme-docs"];

    await Promise.all(skills.map((skill) => recordStep(companion, "acme-fix", "apply", skill)));

    expect((await readDeliveryRecord(companion))?.stages?.apply?.toSorted()).toEqual(
      skills.toSorted(),
    );
  });

  test("a change without a record gets an unlinked one", async () => {
    await recordStep(companion, "acme-fix", "draft", "acme-draft");

    expect(await readDeliveryRecord(companion)).toEqual({
      ...unlinkedRecord("acme-fix"),
      stages: { draft: ["acme-draft"] },
    });
  });

  test("another write of the record keeps the steps", async () => {
    await recordStep(companion, "acme-fix", "apply", "mate-apply-change");
    const record = await readOrUnlinkedRecord(companion, "acme-fix");

    await writeDeliveryRecord(
      companion,
      upsertDelivery(record, REPO, { branch: "workset/acme-fix" }),
    );

    expect((await readDeliveryRecord(companion))?.stages).toEqual({
      apply: ["mate-apply-change"],
    });
  });

  test("a value that is no list of skills reads as no steps and is replaced", async () => {
    await fs.writeFile(
      file(),
      "version: 1\nchange: acme-fix\nstages:\n  apply: done\n  build: [acme-build, 3]\ndeliveries: []\n",
    );

    expect((await readDeliveryRecord(companion))?.stages).toEqual({ build: ["acme-build"] });

    await recordStep(companion, "acme-fix", "apply", "mate-apply-change");

    expect((await readDeliveryRecord(companion))?.stages).toEqual({
      apply: ["mate-apply-change"],
      build: ["acme-build"],
    });
  });

  test("a stage's steps are dropped, the last one with the stages key", () => {
    const record: DeliveryRecord = {
      ...unlinkedRecord("acme-fix"),
      stages: { apply: ["mate-apply-change"], submit: ["acme-pr-check"] },
    };

    expect(withoutStage(record, "submit").stages).toEqual({ apply: ["mate-apply-change"] });
    expect(withoutStage(withoutStage(record, "submit"), "apply")).not.toHaveProperty("stages");
    expect(withoutStage(record, "build")).toBe(record);
  });

  test("a damaged record is reported, not rewritten", async () => {
    await fs.writeFile(file(), "deliveries: nope\n");

    await expect(recordStep(companion, "acme-fix", "apply", "acme-a")).rejects.toThrow("malformed");
    expect(await fs.readFile(file(), "utf8")).toBe("deliveries: nope\n");
  });
});
