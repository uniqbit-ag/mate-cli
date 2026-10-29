import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenSpecRunOptions, RunOpenSpec } from "../openspec-cli";
import {
  archiveChange,
  type ArchiveChangeDeps,
  type ArchiveRequest,
  type ArchiveResult,
} from "./archive-change";
import type { WorkingRepoGit } from "./branches";
import type { DeliveryEnvironment } from "./environment";
import { parseRemote } from "./forge";
import { DELIVERY_FILE, unlinkedRecord, upsertDelivery, writeDeliveryRecord } from "./record";

const REPO = "acme/acme-app";
let companion: string;
let calls: string[];

const changeDir = (name: string) => path.join(companion, "openspec", "changes", name);

function repoGit(existing: string[] = []): WorkingRepoGit {
  return {
    currentBranch: async () => "change/x",
    defaultBranch: async () => "main",
    remoteUrl: async () => "https://github.com/acme/acme-app.git",
    unpushedCommits: async () => [],
    branchExists: async (branch) => existing.includes(branch),
  };
}

function environment(
  overrides: { existing?: string[]; slug?: string | null } = {},
): DeliveryEnvironment {
  const slug = overrides.slug === undefined ? REPO : overrides.slug;
  return {
    companionPath: companion,
    workingRepo: {
      path: "/repo",
      slug,
      forgeRepo: slug ? parseRemote(`https://github.com/${slug}.git`) : null,
      git: repoGit(overrides.existing),
    },
    protectedPatterns: [],
  };
}

/** Moves the change directory the way `openspec archive <change> --yes` does; status fails. */
const fakeOpenSpec: RunOpenSpec = async (args: string[], { cwd }: OpenSpecRunOptions) => {
  calls.push(args[0]);
  if (args[0] === "status") return { code: 1, stdout: "", stderr: "no status" };
  const [, change] = args;
  const target = path.join(cwd, "openspec", "changes", "archive", `2026-10-28-${change}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(path.join(cwd, "openspec", "changes", change), target);
  return { code: 0, stdout: "archived", stderr: "" };
};

function withStatus(artifacts: Record<string, string>): RunOpenSpec {
  return async (args, options) => {
    if (args[0] !== "status") return fakeOpenSpec(args, options);
    calls.push("status");
    const stdout = JSON.stringify({
      schemaName: "mate-v1",
      artifacts: Object.entries(artifacts).map(([id, status]) => ({ id, status })),
    });
    return { code: 0, stdout, stderr: "" };
  };
}

async function archive(
  request: Partial<ArchiveRequest> = {},
  deps: ArchiveChangeDeps = {},
  env: DeliveryEnvironment = environment(),
): Promise<ArchiveResult> {
  const outcome = await archiveChange(
    env,
    { change: "x", ...request },
    {
      resolveToken: async () => null,
      now: () => new Date("2026-10-28T10:00:00.000Z"),
      runOpenSpec: fakeOpenSpec,
      ...deps,
    },
  );
  if (!("result" in outcome)) throw new Error(`refused: ${outcome.refusal.reason}`);
  return outcome.result;
}

async function archivedRecord(change: string): Promise<string> {
  return fs.readFile(
    path.join(companion, "openspec", "changes", "archive", `2026-10-28-${change}`, DELIVERY_FILE),
    "utf8",
  );
}

async function dependOnActiveChange(): Promise<void> {
  await fs.writeFile(path.join(changeDir("x"), "proposal.md"), "---\ndependsOn: [a]\n---\n");
  await fs.mkdir(changeDir("a"), { recursive: true });
}

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "archive-change-"));
  await fs.mkdir(changeDir("x"), { recursive: true });
  calls = [];
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
});

describe("archiveChange", () => {
  test("a linked, unmerged change is archived and reported as waiting", async () => {
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(unlinkedRecord("x"), REPO, { branch: "change/x" }),
    );
    const result = await archive();
    expect(result).toMatchObject({
      status: "archived",
      path: "openspec/changes/archive/2026-10-28-x",
      settlement: { status: "waiting" },
    });
    expect(result.message).toContain("waits until its delivery is merged");
    expect(await archivedRecord("x")).toContain("change/x");
  });

  test("recording another repository's branch still refreshes every delivery", async () => {
    const other = "acme/acme-web";
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(unlinkedRecord("x"), REPO, { branch: "change/x" }),
    );
    const result = await archive({
      repository: other,
      delivery: { branch: "change/x", direct: false },
    });
    expect(result.outcomes.map((outcome) => outcome.repository)).toEqual([REPO, other]);
  });

  test("a merged change is reported as publishable", async () => {
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(unlinkedRecord("x"), REPO, {
        branch: "change/x",
        merge: { state: "merged", source: "user", checkedAt: "t" },
      }),
    );
    const result = await archive();
    expect(result.settlement.status).toBe("merged");
    expect(result.message).toContain("mate-publish-artifact");
  });

  test("an unlinked change answers needs-branch, suggesting the existing default branch", async () => {
    const result = await archive({}, {}, environment({ existing: ["change/x"] }));
    expect(result).toMatchObject({ status: "needs-branch", suggestedBranch: "change/x" });
    expect(calls).not.toContain("archive");
  });

  test("a delivery branch is recorded before archiving", async () => {
    const result = await archive({ delivery: { branch: "change/x", direct: false } });
    expect(result.status).toBe("archived");
    expect(result.record.deliveries[0]).toEqual({ repository: REPO, branch: "change/x" });
  });

  test("the default branch is refused unless it is a direct delivery", async () => {
    const outcome = await archiveChange(
      environment(),
      { change: "x", delivery: { branch: "main", direct: false } },
      { resolveToken: async () => null, runOpenSpec: fakeOpenSpec },
    );
    expect(outcome).toEqual({
      refusal: { reason: "protected-branch", branch: "main", protection: "default" },
    });
    expect(calls).toEqual([]);
    const result = await archive({ delivery: { branch: "main", direct: true } });
    expect(result.record.deliveries[0]).toMatchObject({ branch: "main", direct: true });
  });

  test("skipBranch archives with an unlinked record", async () => {
    const result = await archive({ skipBranch: true });
    expect(result).toMatchObject({ status: "archived", settlement: { status: "unlinked" } });
    expect(await archivedRecord("x")).toContain("deliveries: []");
  });

  test("a not-applicable change is archived and publishable", async () => {
    const result = await archive({ delivery: { notApplicable: "specification only" } });
    expect(result.settlement.status).toBe("not-applicable");
  });

  test("an explicit repository is recorded when the Working Repository has no remote", async () => {
    const result = await archive(
      { repository: REPO, delivery: { branch: "change/x", direct: false } },
      {},
      environment({ slug: null }),
    );
    expect(result.status).toBe("archived");
    expect(result.record.deliveries[0]).toEqual({ repository: REPO, branch: "change/x" });
  });

  test("an unknown change is refused before OpenSpec runs", async () => {
    const outcome = await archiveChange(environment(), { change: "nope" }, {});
    expect(outcome).toEqual({ refusal: { reason: "unknown-change", change: "nope" } });
    expect(calls).toEqual([]);
  });

  describe("warnings", () => {
    test("reach onWarnings before openspec archive runs", async () => {
      await dependOnActiveChange();
      const order: string[] = [];
      const result = await archive(
        { skipBranch: true },
        {
          onWarnings: (warnings) => order.push(...warnings.map((warning) => warning.kind)),
          runOpenSpec: async (args, options) => {
            if (args[0] === "archive") order.push("archive");
            return fakeOpenSpec(args, options);
          },
        },
      );
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: "dependency", change: "a" }),
      ]);
      expect(order).toEqual(["dependency", "archive"]);
    });

    test("a needs-branch result carries warnings without calling onWarnings", async () => {
      await dependOnActiveChange();
      let called = false;
      const result = await archive({}, { onWarnings: () => (called = true) });
      expect(result.status).toBe("needs-branch");
      expect(result.warnings).toHaveLength(1);
      expect(called).toBe(false);
    });

    test("a failed archive keeps the warnings and leaves the record in place", async () => {
      await dependOnActiveChange();
      let shown = 0;
      const result = await archive(
        { skipBranch: true },
        {
          onWarnings: (warnings) => (shown = warnings.length),
          runOpenSpec: async () => ({ code: 1, stdout: "", stderr: "tasks incomplete" }),
        },
      );
      expect(result).toMatchObject({ status: "failed", path: null });
      expect(result.message).toContain("tasks incomplete");
      expect(result.warnings).toHaveLength(1);
      expect(shown).toBe(1);
      expect(await fs.readFile(path.join(changeDir("x"), DELIVERY_FILE), "utf8")).toContain(
        "deliveries",
      );
    });

    test("unscoped deliveries reach onWarnings", async () => {
      await fs.writeFile(
        path.join(changeDir("x"), "proposal.md"),
        "---\nscopes:\n  - repository: acme/platform/api\n    area: .\n---\n",
      );
      await writeDeliveryRecord(
        changeDir("x"),
        upsertDelivery(unlinkedRecord("x"), "platform/api", { branch: "change/x" }),
      );
      let unscoped: unknown;
      const result = await archive(
        {},
        { onWarnings: (_warnings, entries) => (unscoped = entries) },
      );
      expect(result.status).toBe("archived");
      expect(unscoped).toEqual([{ repository: "platform/api", closest: "acme/platform/api" }]);
    });
  });

  describe("incomplete planning", () => {
    test("artifacts neither done nor skipped are warned about", async () => {
      const result = await archive(
        { skipBranch: true },
        {
          runOpenSpec: withStatus({
            proposal: "done",
            specs: "done",
            design: "ready",
            tasks: "done",
          }),
        },
      );
      expect(result.status).toBe("archived");
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: "incomplete-planning", artifacts: ["design"] }),
      ]);
    });

    test("complete planning adds no warning", async () => {
      const result = await archive(
        { skipBranch: true },
        { runOpenSpec: withStatus({ specs: "done", tasks: "done" }) },
      );
      expect(result.warnings).toEqual([]);
    });

    test("an unreadable status archives without the warning", async () => {
      const result = await archive({ skipBranch: true });
      expect(calls).toEqual(["status", "archive"]);
      expect(result).toMatchObject({ status: "archived", warnings: [] });
    });

    test("a needs-branch result includes the warning", async () => {
      const result = await archive({}, { runOpenSpec: withStatus({ design: "blocked" }) });
      expect(result.status).toBe("needs-branch");
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: "incomplete-planning", artifacts: ["design"] }),
      ]);
    });
  });
});
