import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { unlinkedRecord, upsertDelivery, writeDeliveryRecord, type DeliveryRecord } from "./record";
import {
  newBranchBase,
  resolveDeliveryBranch,
  worktreeAddArgs,
  type HasRef,
} from "./resolve-branch";

const WEB = "acme/web";
let companion: string;

const changeDir = (name: string) => path.join(companion, "openspec", "changes", name);

async function record(
  change: string,
  edit: { branch?: string; ticket?: string; direct?: boolean },
) {
  let next: DeliveryRecord = unlinkedRecord(change);
  if (edit.ticket) next = { ...next, ticket: edit.ticket };
  if (edit.branch) {
    next = upsertDelivery(next, WEB, { branch: edit.branch, direct: edit.direct ?? false });
  }
  await writeDeliveryRecord(changeDir(change), next);
}

async function workset(id: string, changes: string[]): Promise<void> {
  await fs.mkdir(path.join(companion, "worksets"), { recursive: true });
  await fs.writeFile(
    path.join(companion, "worksets", `${id}.yaml`),
    `id: ${id}\nrepositories: [${WEB}]\nchanges: ${JSON.stringify(changes)}\n`,
  );
}

/** Local branches; `origin/<b>` entries exist only on the remote. */
const existing =
  (...branches: string[]): HasRef =>
  async (ref) =>
    branches.some(
      (branch) =>
        ref === (branch.startsWith("origin/") ? `refs/remotes/${branch}` : `refs/heads/${branch}`),
    );

const resolve = (worksetId: string, hasRef: HasRef | null) =>
  resolveDeliveryBranch({ companionPath: companion, repository: WEB, hasRef, worksetId });

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-branch-"));
  for (const change of ["acme-fix", "acme-a", "acme-b"]) {
    await fs.mkdir(changeDir(change), { recursive: true });
  }
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
});

describe("resolveDeliveryBranch", () => {
  test("computes workset/<id> without records or branches", async () => {
    expect(await resolve("acme-fix", existing())).toEqual({
      worksetId: "acme-fix",
      branch: "workset/acme-fix",
      source: "new",
      ticket: null,
      diagnostics: [],
    });
  });

  test("a single ticket names the computed branch", async () => {
    await record("acme-fix", { ticket: "ABC-123" });
    expect(await resolve("acme-fix", existing())).toMatchObject({
      branch: "workset/ABC-123-acme-fix",
      ticket: "ABC-123",
    });
  });

  test("a recorded branch wins for every caller", async () => {
    await workset("acme-login", ["acme-a", "acme-b"]);
    await record("acme-a", { branch: "feature/acme", ticket: "ABC-123" });
    const resolution = await resolve("acme-login", existing("workset/ABC-123-acme-login"));
    expect(resolution.branch).toBe("feature/acme");
  });

  test("differing recorded branches resolve to none", async () => {
    await workset("acme-login", ["acme-a", "acme-b"]);
    await record("acme-a", { branch: "feature/acme" });
    await record("acme-b", { branch: "workset/acme-login" });
    const resolution = await resolve("acme-login", existing());
    expect(resolution.branch).toBeNull();
    expect(resolution.diagnostics.join()).toContain("feature/acme, workset/acme-login");
  });

  test("a direct delivery is not the Workset's branch", async () => {
    await record("acme-fix", { branch: "main", direct: true });
    expect((await resolve("acme-fix", existing())).branch).toBe("workset/acme-fix");
  });

  test("a ticket added after the branch exists keeps the existing branch", async () => {
    await record("acme-fix", { ticket: "ABC-123" });
    const resolution = await resolve("acme-fix", existing("workset/acme-fix"));
    expect(resolution.branch).toBe("workset/acme-fix");
  });

  test("an existing ticketed branch comes before the plain one", async () => {
    await record("acme-fix", { ticket: "ABC-123" });
    const resolution = await resolve(
      "acme-fix",
      existing("workset/acme-fix", "workset/ABC-123-acme-fix"),
    );
    expect(resolution.branch).toBe("workset/ABC-123-acme-fix");
  });

  test("changes without a ticket do not conflict", async () => {
    await workset("acme-login", ["acme-a", "acme-b"]);
    await record("acme-a", { ticket: "ABC-123" });
    const resolution = await resolve("acme-login", existing());
    expect(resolution).toMatchObject({ branch: "workset/ABC-123-acme-login", diagnostics: [] });
  });

  test("conflicting tickets keep the plain name and are reported", async () => {
    await workset("acme-login", ["acme-a", "acme-b"]);
    await record("acme-a", { ticket: "ABC-123" });
    await record("acme-b", { ticket: "ABC-456" });
    const resolution = await resolve("acme-login", existing());
    expect(resolution.branch).toBe("workset/acme-login");
    expect(resolution.ticket).toBeNull();
    expect(resolution.diagnostics.join()).toContain("ABC-123, ABC-456");
  });

  test("an identity collision resolves to none", async () => {
    await workset("acme-fix", ["acme-a"]);
    const resolution = await resolve("acme-fix", existing());
    expect(resolution.branch).toBeNull();
    expect(resolution.diagnostics.join()).toContain("collide");
  });

  test("an invalid Workset record resolves to none", async () => {
    await fs.mkdir(path.join(companion, "worksets"), { recursive: true });
    await fs.writeFile(path.join(companion, "worksets", "acme-bad.yaml"), "id: wrong\n");
    const resolution = await resolve("acme-fix", existing());
    expect(resolution.branch).toBeNull();
    expect(resolution.diagnostics.join()).toContain("acme-bad.yaml");
  });

  test("without a checkout the computed name is used", async () => {
    await record("acme-fix", { ticket: "ABC-123" });
    expect((await resolve("acme-fix", null)).branch).toBe("workset/ABC-123-acme-fix");
  });

  test("source reports a local branch before origin, then remote-only", async () => {
    expect(
      await resolve("acme-fix", existing("workset/acme-fix", "origin/workset/acme-fix")),
    ).toMatchObject({ branch: "workset/acme-fix", source: "local" });
    expect(await resolve("acme-fix", existing("origin/workset/acme-fix"))).toMatchObject({
      branch: "workset/acme-fix",
      source: "remote",
    });
  });

  test("a remote-only branch wins over a later ticket", async () => {
    await record("acme-fix", { ticket: "ABC-123" });
    expect(await resolve("acme-fix", existing("origin/workset/acme-fix"))).toMatchObject({
      branch: "workset/acme-fix",
      source: "remote",
    });
  });

  test("a recorded branch reports where it lives", async () => {
    await record("acme-fix", { branch: "feature/acme" });
    expect(await resolve("acme-fix", existing("origin/feature/acme"))).toMatchObject({
      branch: "feature/acme",
      source: "remote",
    });
  });

  test("without a checkout the source is unknown", async () => {
    expect((await resolve("acme-fix", null)).source).toBeNull();
  });

  test("a change and its Workset id resolve alike", async () => {
    await workset("acme-login", ["acme-a", "acme-b"]);
    await record("acme-b", { ticket: "ABC-123" });
    const byChange = await resolveDeliveryBranch({
      companionPath: companion,
      repository: WEB,
      hasRef: existing(),
      change: "acme-a",
    });
    expect(byChange).toEqual(await resolve("acme-login", existing()));
    expect(byChange.branch).toBe("workset/ABC-123-acme-login");
  });
});

describe("worktreeAddArgs", () => {
  test("checks out, tracks, or starts the branch by source", () => {
    expect(worktreeAddArgs({ branch: "workset/acme", source: "local" }, "/wt")).toEqual([
      "worktree",
      "add",
      "/wt",
      "workset/acme",
    ]);
    expect(worktreeAddArgs({ branch: "workset/acme", source: "remote" }, "/wt")).toEqual([
      "worktree",
      "add",
      "--track",
      "-b",
      "workset/acme",
      "/wt",
      "origin/workset/acme",
    ]);
    expect(worktreeAddArgs({ branch: "workset/acme", source: "new" }, "/wt")).toEqual([
      "worktree",
      "add",
      "--no-track",
      "-b",
      "workset/acme",
      "/wt",
      "origin/HEAD",
    ]);
  });
});

describe("newBranchBase", () => {
  const refs =
    (...names: string[]) =>
    async (ref: string) =>
      names.some((name) => ref === `refs/remotes/origin/${name}`);

  test("origin/HEAD, else origin/main or origin/master, else HEAD", async () => {
    expect(await newBranchBase(refs("HEAD", "main"))).toBe("origin/HEAD");
    expect(await newBranchBase(refs("main"))).toBe("origin/main");
    expect(await newBranchBase(refs("master"))).toBe("origin/master");
    expect(await newBranchBase(refs())).toBe("HEAD");
  });

  test("a new branch starts from the given base", () => {
    expect(
      worktreeAddArgs({ branch: "workset/acme", source: "new" }, "/wt", "origin/main"),
    ).toEqual(["worktree", "add", "--no-track", "-b", "workset/acme", "/wt", "origin/main"]);
  });
});
