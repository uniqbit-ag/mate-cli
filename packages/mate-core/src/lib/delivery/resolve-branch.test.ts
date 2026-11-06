import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  unlinkedRecord,
  upsertDelivery,
  writeDeliveryRecord,
  type DeliveryRecord,
  type MergeState,
} from "./record";
import type { MergeGit, PatchMatch } from "./merge-git";
import {
  listRefsWith,
  mergeProbeWith,
  newBranchBase,
  resolveDeliveryBranch,
  worktreeAddArgs,
  type HasRef,
  type ListRefs,
  type MergeProbe,
} from "./resolve-branch";

const WEB = "acme/web";
let companion: string;

const changeDir = (name: string) => path.join(companion, "openspec", "changes", name);

async function record(
  change: string,
  edit: { branch?: string; direct?: boolean; merge?: MergeState },
) {
  let next: DeliveryRecord = unlinkedRecord(change);
  if (edit.branch) {
    next = upsertDelivery(next, WEB, { branch: edit.branch, direct: edit.direct ?? false });
  }
  if (edit.merge) {
    next = upsertDelivery(next, WEB, {
      merge: { state: edit.merge, source: "git", checkedAt: "2026-11-05T00:00:00.000Z" },
    });
  }
  await writeDeliveryRecord(changeDir(change), next);
}

async function dependsOn(change: string, dependencies: string[]): Promise<void> {
  await fs.writeFile(
    path.join(changeDir(change), "proposal.md"),
    `---\nchange: ${change}\ndependsOn: ${JSON.stringify(dependencies)}\n---\n`,
  );
}

async function workset(id: string, changes: string[], ticket?: string): Promise<void> {
  await fs.mkdir(path.join(companion, "worksets"), { recursive: true });
  await fs.writeFile(
    path.join(companion, "worksets", `${id}.yaml`),
    `id: ${id}\nrepositories: [${WEB}]\nchanges: ${JSON.stringify(changes)}\n${ticket ? `ticket: ${ticket}\n` : ""}`,
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

const resolve = (worksetId: string, hasRef: HasRef | null, ticket?: string) =>
  resolveDeliveryBranch({
    companionPath: companion,
    repository: WEB,
    hasRef,
    worksetId,
    ...(ticket ? { ticket } : {}),
  });

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-branch-"));
  for (const change of ["acme-fix", "acme-a", "acme-b", "acme-api", "acme-ui", "acme-worker"]) {
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
      inheritedFrom: [],
      diagnostics: [],
    });
  });

  test("a given ticket names the computed branch", async () => {
    expect(await resolve("acme-fix", existing(), "ABC-123")).toMatchObject({
      branch: "workset/ABC-123-acme-fix",
      diagnostics: [],
    });
  });

  test("a recorded branch wins for every caller", async () => {
    await workset("acme-login", ["acme-a", "acme-b"]);
    await record("acme-a", { branch: "feature/acme" });
    const resolution = await resolve(
      "acme-login",
      existing("workset/ABC-123-acme-login"),
      "ABC-123",
    );
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

  test("a given ticket names its own branch over an existing plain one", async () => {
    const resolution = await resolve("acme-fix", existing("workset/acme-fix"), "ABC-123");
    expect(resolution).toMatchObject({ branch: "workset/ABC-123-acme-fix", source: "new" });
    expect(resolution.diagnostics.join()).toContain("Existing workset/acme-fix is not used");
  });

  test("a different ticket on a recorded ticket branch names the rename", async () => {
    await workset("acme-login", ["acme-a", "acme-b"]);
    await record("acme-a", { branch: "workset/abc-1-acme-login" });
    const resolution = await resolve("acme-login", existing(), "ABC-2");
    expect(resolution.branch).toBe("workset/abc-1-acme-login");
    expect(resolution.diagnostics.join()).toContain(
      "run `git branch -m workset/abc-1-acme-login workset/ABC-2-acme-login`, then `mate artifact link acme-a acme-b --branch workset/ABC-2-acme-login`",
    );
    const same = await resolve("acme-login", existing(), "ABC-1");
    expect(same.diagnostics.join()).not.toContain("git branch -m");
  });

  test("a given ticket keeps a recorded branch and says so", async () => {
    await record("acme-fix", { branch: "workset/acme-fix" });
    const resolution = await resolve("acme-fix", existing("workset/acme-fix"), "ABC-123");
    expect(resolution.branch).toBe("workset/acme-fix");
    expect(resolution.diagnostics.join()).toContain("Ticket ABC-123 does not name the branch");
  });

  test("an existing ticketed branch comes before the plain one", async () => {
    const resolution = await resolve(
      "acme-fix",
      existing("workset/acme-fix", "workset/ABC-123-acme-fix"),
      "ABC-123",
    );
    expect(resolution.branch).toBe("workset/ABC-123-acme-fix");
  });

  test("changes without a branch do not conflict with a ticketed one", async () => {
    await workset("acme-login", ["acme-a", "acme-b"]);
    await record("acme-a", { branch: "workset/ABC-123-acme-login" });
    const resolution = await resolve("acme-login", existing());
    expect(resolution).toMatchObject({ branch: "workset/ABC-123-acme-login", diagnostics: [] });
  });

  test("a canary ticket in a record names nothing", async () => {
    await fs.writeFile(
      path.join(changeDir("acme-fix"), "delivery.yaml"),
      "version: 1\nchange: acme-fix\nticket: ABC-123\ndeliveries: []\n",
    );
    expect((await resolve("acme-fix", existing())).branch).toBe("workset/acme-fix");
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
    expect((await resolve("acme-fix", null, "ABC-123")).branch).toBe("workset/ABC-123-acme-fix");
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

  test("a remote-only plain branch does not take a given ticket's place", async () => {
    expect(await resolve("acme-fix", existing("origin/workset/acme-fix"), "ABC-123")).toMatchObject(
      { branch: "workset/ABC-123-acme-fix", source: "new" },
    );
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
    await record("acme-b", { branch: "workset/ABC-123-acme-login" });
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

describe("ticket branches found by name", () => {
  const listed =
    (...refs: string[]): ListRefs =>
    async (prefixes) =>
      refs.filter((ref) => prefixes.some((prefix) => ref.startsWith(prefix)));
  const find = (...refs: string[]) =>
    resolveDeliveryBranch({
      companionPath: companion,
      repository: WEB,
      hasRef: existing(...refs.map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ""))),
      listRefs: listed(...refs),
      worksetId: "acme-fix",
    });

  test("without a ticket the single ticket branch is found", async () => {
    expect(await find("refs/remotes/origin/workset/abc-7-acme-fix")).toMatchObject({
      branch: "workset/abc-7-acme-fix",
      source: "remote",
      diagnostics: [],
    });
  });

  test("an existing plain branch comes first", async () => {
    expect(
      (await find("refs/heads/workset/acme-fix", "refs/heads/workset/ABC-7-acme-fix")).branch,
    ).toBe("workset/acme-fix");
  });

  test("several ticket branches resolve to none", async () => {
    const resolution = await find(
      "refs/heads/workset/ABC-7-acme-fix",
      "refs/remotes/origin/workset/ABC-8-acme-fix",
    );
    expect(resolution.branch).toBeNull();
    expect(resolution.diagnostics.join()).toContain(
      "several ticket branches (workset/ABC-7-acme-fix, workset/ABC-8-acme-fix)",
    );
  });

  test("another Workset's branch is not a ticket branch", async () => {
    expect((await find("refs/heads/workset/ABC-7-old-acme-fix")).branch).toBe("workset/acme-fix");
  });
});

describe("a team branch template", () => {
  const listed =
    (...refs: string[]): ListRefs =>
    async (prefixes) =>
      refs.filter((ref) => prefixes.some((prefix) => ref.startsWith(prefix)));
  const find = (template: string, refs: string[], ticket?: string) =>
    resolveDeliveryBranch({
      companionPath: companion,
      repository: WEB,
      hasRef: existing(...refs.map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ""))),
      listRefs: listed(...refs),
      worksetId: "acme-fix",
      template,
      ...(ticket ? { ticket } : {}),
    });

  test("names a new branch with and without a ticket", async () => {
    expect(await find("feature/{ticket}-{workset}", [], "ABC-123")).toMatchObject({
      branch: "feature/ABC-123-acme-fix",
      source: "new",
      diagnostics: [],
    });
    expect((await find("feature/{ticket}/{workset}", [])).branch).toBe("feature/acme-fix");
    expect((await find("feature/{workset}", [], "ABC-123")).branch).toBe("feature/acme-fix");
  });

  test("finds a ticket branch again without the ticket", async () => {
    expect(
      await find("feature/{ticket}/{workset}", ["refs/heads/feature/ABC-123/acme-fix"]),
    ).toMatchObject({ branch: "feature/ABC-123/acme-fix", source: "local", diagnostics: [] });
  });

  test("falls back to a branch made under the default template", async () => {
    const plain = await find("feature/{ticket}-{workset}", ["refs/heads/workset/acme-fix"]);
    expect(plain.branch).toBe("workset/acme-fix");
    expect(plain.diagnostics.join()).toContain("follows the default template");
    const ticketed = await find("feature/{ticket}-{workset}", [
      "refs/remotes/origin/workset/ABC-7-acme-fix",
    ]);
    expect(ticketed).toMatchObject({ branch: "workset/ABC-7-acme-fix", source: "remote" });
  });

  test("a branch under the template wins over one under the default", async () => {
    const resolution = await find("feature/{ticket}-{workset}", [
      "refs/heads/workset/acme-fix",
      "refs/heads/feature/ABC-1-acme-fix",
    ]);
    expect(resolution).toMatchObject({ branch: "feature/ABC-1-acme-fix", diagnostics: [] });
  });

  test("a recorded branch is kept after the template changes", async () => {
    await record("acme-fix", { branch: "workset/acme-fix" });
    expect((await find("feature/{ticket}-{workset}", [])).branch).toBe("workset/acme-fix");
  });

  test("an explicit ticket finds its branch under the default template", async () => {
    const resolution = await find(
      "feature/{ticket}-{workset}",
      ["refs/heads/workset/ABC-1-acme-fix"],
      "ABC-1",
    );
    expect(resolution).toMatchObject({ branch: "workset/ABC-1-acme-fix", source: "local" });
    expect(resolution.diagnostics).toHaveLength(1);
    expect(resolution.diagnostics[0]).toContain("follows the default template");
  });

  test("an explicit ticket reports a plain branch under the default template", async () => {
    const resolution = await find(
      "feature/{ticket}-{workset}",
      ["refs/heads/workset/acme-fix"],
      "ABC-1",
    );
    expect(resolution.branch).toBe("feature/ABC-1-acme-fix");
    expect(resolution.diagnostics.join()).toContain("Existing workset/acme-fix is not used");
  });

  test("a ticket the template has no place for is reported", async () => {
    const resolution = await find("feature/{workset}", [], "ABC-123");
    expect(resolution.branch).toBe("feature/acme-fix");
    expect(resolution.diagnostics.join()).toContain("has no {ticket}");
  });

  test("a recorded default-template branch gets the rename hint", async () => {
    await record("acme-fix", { branch: "workset/ABC-1-acme-fix" });
    const resolution = await find("feature/{ticket}-{workset}", [], "XYZ-2");
    expect(resolution.branch).toBe("workset/ABC-1-acme-fix");
    expect(resolution.diagnostics.join()).toContain(
      "git branch -m workset/ABC-1-acme-fix feature/XYZ-2-acme-fix",
    );
  });

  test("a template without {ticket} lists no refs", async () => {
    let listedCount = 0;
    await resolveDeliveryBranch({
      companionPath: companion,
      repository: WEB,
      hasRef: existing(),
      listRefs: async () => {
        listedCount += 1;
        return [];
      },
      worksetId: "acme-fix",
      template: "feature/{workset}",
    });
    // Only the default template's fallback lists refs.
    expect(listedCount).toBe(1);
  });
});

describe("mergeProbeWith", () => {
  const HEAD = "a".repeat(40);
  const gitWith = (state: {
    onDefault?: boolean;
    firstParent?: boolean;
    match?: PatchMatch | null;
  }): MergeGit => ({
    isRepository: async () => true,
    tip: async () => HEAD,
    hasCommit: async () => true,
    isAncestor: async () => state.onDefault ?? false,
    onFirstParent: async () => state.firstParent ?? false,
    patchMatch: async () => state.match ?? null,
    lastFetchedAt: async () => null,
    fetch: async () => ({ ok: true }),
  });
  const probe = (state: Parameters<typeof gitWith>[0]) =>
    mergeProbeWith(gitWith(state), "main")("workset/acme-api", undefined);

  test("a merge commit reads merged", async () => {
    expect(await probe({ onDefault: true, firstParent: false })).toBe("merged");
  });

  test("a squash or rebase match reads squashed", async () => {
    for (const style of ["squash", "rebase"] as const) {
      expect(await probe({ match: { commit: HEAD, style } })).toBe("squashed");
    }
  });

  test("a head on the default branch's own line, or no match, reads open", async () => {
    expect(await probe({ onDefault: true, firstParent: true })).toBe("open");
    expect(await probe({})).toBe("open");
  });
});

describe("listRefsWith", () => {
  test("splits for-each-ref output and treats a failure as no refs", async () => {
    const calls: string[][] = [];
    const refs = listRefsWith(async (args) => {
      calls.push(args);
      return "refs/heads/workset/a\nrefs/heads/workset/b\n";
    });
    expect(await refs(["refs/heads/workset/"])).toEqual([
      "refs/heads/workset/a",
      "refs/heads/workset/b",
    ]);
    expect(calls).toEqual([["for-each-ref", "--format=%(refname)", "refs/heads/workset/"]]);
    expect(await listRefsWith(async () => null)(["refs/heads/"])).toEqual([]);
  });
});

describe("Workset record ticket", () => {
  test("names the branch of a Workset without changes", async () => {
    await workset("acme-login", [], "ABC-123");
    expect((await resolve("acme-login", existing())).branch).toBe("workset/ABC-123-acme-login");
  });

  test("the caller's ticket wins", async () => {
    await workset("acme-login", [], "ABC-123");
    expect((await resolve("acme-login", existing(), "ABC-456")).branch).toBe(
      "workset/ABC-456-acme-login",
    );
  });

  test("a recorded or existing branch still wins", async () => {
    await workset("acme-login", ["acme-a"], "ABC-123");
    expect((await resolve("acme-login", existing("workset/acme-login"))).branch).toBe(
      "workset/acme-login",
    );
    await record("acme-a", { branch: "feature/acme" });
    expect((await resolve("acme-login", existing())).branch).toBe("feature/acme");
  });

  test("a changed record ticket keeps the branch the first one named", async () => {
    await workset("acme-login", [], "ABC-2");
    const resolution = await resolveDeliveryBranch({
      companionPath: companion,
      repository: WEB,
      hasRef: existing("origin/workset/ABC-1-acme-login"),
      listRefs: async () => ["refs/remotes/origin/workset/ABC-1-acme-login"],
      worksetId: "acme-login",
    });
    expect(resolution).toMatchObject({ branch: "workset/ABC-1-acme-login", source: "remote" });
    expect(resolution.diagnostics.join()).toContain("Ticket ABC-2 does not name the branch");
  });

  test("link and worktree resolve the same name for a member change", async () => {
    await workset("acme-login", ["acme-a"], "ABC-123");
    const byChange = await resolveDeliveryBranch({
      companionPath: companion,
      repository: WEB,
      hasRef: existing(),
      change: "acme-a",
    });
    expect(byChange.branch).toBe("workset/ABC-123-acme-login");
  });
});

describe("dependsOn inheritance", () => {
  test("a later slice continues on its dependency's open branch", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    await record("acme-api", { branch: "workset/ABC-123-acme-api" });
    const resolution = await resolve("acme-worker", existing("workset/ABC-123-acme-api"));
    expect(resolution).toMatchObject({
      branch: "workset/ABC-123-acme-api",
      source: "local",
      inheritedFrom: ["acme-api"],
    });
  });

  test("a dependency never checked for a merge is inherited with a warning", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    await record("acme-api", { branch: "workset/acme-api" });
    const unchecked = await resolve("acme-worker", existing("workset/acme-api"));
    expect(unchecked.diagnostics.join()).toContain(
      "never checked; if it is merged, run `mate artifact link acme-api --refresh`",
    );
    await record("acme-api", { branch: "workset/acme-api", merge: "open" });
    expect((await resolve("acme-worker", existing("workset/acme-api"))).diagnostics).toEqual([]);
  });

  describe("a local merge probe for a dependency never checked", () => {
    const probing = (answer: Awaited<ReturnType<MergeProbe>>, calls: string[] = []) =>
      resolveDeliveryBranch({
        companionPath: companion,
        repository: WEB,
        hasRef: existing("workset/acme-api"),
        mergeProbe: async (branch) => {
          calls.push(branch);
          return answer;
        },
        worksetId: "acme-worker",
      });

    beforeEach(async () => {
      await dependsOn("acme-worker", ["acme-api"]);
      await record("acme-api", { branch: "workset/acme-api" });
    });

    test("an open branch is inherited without a diagnostic", async () => {
      expect(await probing("open")).toMatchObject({
        branch: "workset/acme-api",
        inheritedFrom: ["acme-api"],
        diagnostics: [],
      });
    });

    test("a merged branch is not inherited and is named", async () => {
      const resolution = await probing("merged");
      expect(resolution.branch).toBe("workset/acme-worker");
      expect(resolution.diagnostics.join()).toContain(
        "workset/acme-api of acme-api is merged into the default branch",
      );
    });

    test("a squash-merged branch is not inherited and names the way back", async () => {
      const resolution = await probing("squashed");
      expect(resolution.branch).toBe("workset/acme-worker");
      expect(resolution.diagnostics.join()).toContain(
        "looks squash-merged into the default branch; it is not inherited. If it is still open, run `mate artifact link acme-api --confirm-open`",
      );
    });

    test("a recorded merge state is not probed", async () => {
      await record("acme-api", { branch: "workset/acme-api", merge: "open" });
      const calls: string[] = [];
      expect((await probing("merged", calls)).branch).toBe("workset/acme-api");
      expect(calls).toEqual([]);
    });
  });

  test("its own recorded branch wins over the dependency's", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    await record("acme-api", { branch: "workset/acme-api" });
    await record("acme-worker", { branch: "feature/worker" });
    expect((await resolve("acme-worker", existing("workset/acme-api"))).branch).toBe(
      "feature/worker",
    );
  });

  test("a merged or dropped dependency is not inherited", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    for (const merge of ["merged", "closed-unmerged"] as const) {
      await record("acme-api", { branch: "workset/acme-api", merge });
      expect((await resolve("acme-worker", existing("workset/acme-api"))).branch).toBe(
        "workset/acme-worker",
      );
    }
  });

  test("an open merge state is inherited", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    await record("acme-api", { branch: "workset/acme-api", merge: "open" });
    expect((await resolve("acme-worker", existing("origin/workset/acme-api"))).branch).toBe(
      "workset/acme-api",
    );
  });

  test("a deleted dependency branch is not inherited", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    await record("acme-api", { branch: "workset/acme-api" });
    expect((await resolve("acme-worker", existing())).branch).toBe("workset/acme-worker");
  });

  test("without a checkout an unsettled dependency branch is inherited", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    await record("acme-api", { branch: "workset/acme-api" });
    expect((await resolve("acme-worker", null)).branch).toBe("workset/acme-api");
  });

  test("a direct dependency delivery is not inherited", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    await record("acme-api", { branch: "main", direct: true });
    expect((await resolve("acme-worker", existing("main"))).branch).toBe("workset/acme-worker");
  });

  test("dependencies on different branches inherit none", async () => {
    await dependsOn("acme-worker", ["acme-api", "acme-ui"]);
    await record("acme-api", { branch: "workset/acme-api" });
    await record("acme-ui", { branch: "workset/acme-ui" });
    const resolution = await resolve(
      "acme-worker",
      existing("workset/acme-api", "workset/acme-ui"),
    );
    expect(resolution.branch).toBe("workset/acme-worker");
    expect(resolution.diagnostics.join()).toContain("workset/acme-api, workset/acme-ui");
  });

  test("dependencies sharing one branch are inherited", async () => {
    await dependsOn("acme-worker", ["acme-api", "acme-ui"]);
    await record("acme-api", { branch: "workset/acme-api" });
    await record("acme-ui", { branch: "workset/acme-api" });
    expect(await resolve("acme-worker", existing("workset/acme-api"))).toMatchObject({
      branch: "workset/acme-api",
      inheritedFrom: ["acme-api", "acme-ui"],
    });
  });

  test("an inherited branch is not renamed by a ticket", async () => {
    await dependsOn("acme-worker", ["acme-api"]);
    await record("acme-api", { branch: "workset/acme-api" });
    const resolution = await resolve("acme-worker", existing("workset/acme-api"), "ABC-123");
    expect(resolution.branch).toBe("workset/acme-api");
    expect(resolution.diagnostics.join()).toContain("Ticket ABC-123 does not name the branch");
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
