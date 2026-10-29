import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkingRepoGit } from "../../../../lib/delivery/branches";
import {
  DELIVERY_FILE,
  unlinkedRecord,
  upsertDelivery,
  writeDeliveryRecord,
} from "../../../../lib/delivery/record";
import type { OpenSpecRunOptions } from "../../../../lib/openspec-cli";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { ArchiveResult } from "../../../../lib/delivery/archive-change";
import { runArtifactArchiveCommand, type ArchiveCommandDeps } from "./archive";

const REPO = "acme/acme-app";
let companion: string;
let out: string[];
let err: string[];
let archivedNames: string[];

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

/** Moves the change directory the way `openspec archive <change> --yes` does in the companion. */
async function fakeArchive(args: string[], { cwd: companionPath }: OpenSpecRunOptions) {
  const [command, change, yes] = args;
  if (command !== "archive" || yes !== "--yes" || args.length !== 3) {
    return { code: 2, stdout: "", stderr: `unexpected openspec ${args.join(" ")}` };
  }
  archivedNames.push(change);
  const target = path.join(companionPath, "openspec", "changes", "archive", `2026-10-28-${change}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(path.join(companionPath, "openspec", "changes", change), target);
  return { code: 0, stdout: "archived", stderr: "" };
}

function deps(overrides: Partial<ArchiveCommandDeps> = {}): ArchiveCommandDeps {
  return {
    ensureUnambiguousCompanion: async () => true,
    resolveContext: async () =>
      ({
        companionPath: companion,
        repositoryId: "r",
        repository: { id: "r", path: "/repo" },
      }) as unknown as LaunchContext,
    loadCapabilities: async () => [{ name: "openspec" }],
    workingRepoGit: () => repoGit(),
    resolveToken: async () => null,
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    runOpenSpec: fakeArchive,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
}

async function run(
  argv: string[],
  overrides: Partial<ArchiveCommandDeps> = {},
): Promise<ArchiveResult> {
  out = [];
  err = [];
  await runArtifactArchiveCommand([...argv, "--json"], deps(overrides));
  return JSON.parse(out[0]) as ArchiveResult;
}

async function archivedRecord(change: string): Promise<string> {
  return fs.readFile(
    path.join(companion, "openspec", "changes", "archive", `2026-10-28-${change}`, DELIVERY_FILE),
    "utf8",
  );
}

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-archive-"));
  await fs.mkdir(changeDir("x"), { recursive: true });
  archivedNames = [];
  process.exitCode = 0;
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("mate artifact archive", () => {
  test("a linked, unmerged change is archived and its delivery reported as waiting", async () => {
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(unlinkedRecord("x"), REPO, { branch: "change/x" }),
    );
    const result = await run(["x"]);
    expect(result).toMatchObject({
      status: "archived",
      path: "openspec/changes/archive/2026-10-28-x",
      settlement: { status: "waiting" },
    });
    expect(result.message).toContain("waits until its delivery is merged");
    expect(await archivedRecord("x")).toContain("change/x");
  });

  test("a delivery outside the change's scopes is warned about before archiving and never blocks", async () => {
    await fs.writeFile(
      path.join(changeDir("x"), "proposal.md"),
      "---\nscopes:\n  - repository: acme/platform/api\n    area: .\n---\n",
    );
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(unlinkedRecord("x"), "platform/api", { branch: "change/x" }),
    );
    const result = await run(["x"]);
    expect(result.status).toBe("archived");
    expect(process.exitCode).toBe(0);
    expect(result.settlement.unscoped).toEqual([
      { repository: "platform/api", closest: "acme/platform/api" },
    ]);
    expect(err).toContain(
      "warning: platform/api matches none of x's scopes; did you mean acme/platform/api?",
    );
    expect(await archivedRecord("x")).toContain("repository: platform/api");
  });

  test("an unlinked change is not archived; the existing default branch is suggested", async () => {
    const result = await run(["x"], { workingRepoGit: () => repoGit(["change/x"]) });
    expect(result).toMatchObject({ status: "needs-branch", suggestedBranch: "change/x" });
    expect(archivedNames).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("--branch answers the question and archives", async () => {
    const result = await run(["x", "--branch", "change/x"]);
    expect(result.status).toBe("archived");
    expect(result.record.deliveries[0]).toEqual({ repository: REPO, branch: "change/x" });
  });

  test("the default branch is accepted only as an explicit direct delivery", async () => {
    out = [];
    err = [];
    await runArtifactArchiveCommand(["x", "--branch", "main", "--json"], deps());
    expect(process.exitCode).toBe(1);
    expect(archivedNames).toEqual([]);
    process.exitCode = 0;
    const result = await run(["x", "--branch", "main", "--direct"]);
    expect(result.record.deliveries[0]).toMatchObject({ branch: "main", direct: true });
  });

  test("--skip-branch archives with an unlinked record", async () => {
    const result = await run(["x", "--skip-branch"]);
    expect(result).toMatchObject({ status: "archived", settlement: { status: "unlinked" } });
    expect(await archivedRecord("x")).toContain("deliveries: []");
  });

  test("a not-applicable change is archived and publishable", async () => {
    const result = await run(["x", "--not-applicable", "specification only"]);
    expect(result.settlement.status).toBe("not-applicable");
  });

  test("warnings are reported and never block", async () => {
    await fs.writeFile(path.join(changeDir("x"), "proposal.md"), "---\ndependsOn: [a]\n---\n");
    await fs.mkdir(changeDir("a"), { recursive: true });
    let shownBeforeArchive: string[] = [];
    const result = await run(["x", "--skip-branch"], {
      runOpenSpec: async (args, options) => {
        shownBeforeArchive = [...err];
        return fakeArchive(args, options);
      },
    });
    expect(result.status).toBe("archived");
    expect(result.warnings).toEqual([expect.objectContaining({ kind: "dependency", change: "a" })]);
    expect(shownBeforeArchive).toEqual([`warning: ${result.warnings[0].message}`]);
  });

  describe("incomplete planning", () => {
    const withStatus =
      (artifacts: Record<string, string>, code = 0): ArchiveCommandDeps["runOpenSpec"] =>
      async (args, options) => {
        if (args[0] !== "status") return fakeArchive(args, options);
        const stdout = JSON.stringify({
          schemaName: "mate-v1",
          artifacts: Object.entries(artifacts).map(([id, status]) => ({ id, status })),
        });
        return { code, stdout, stderr: "" };
      };

    test("missing artifacts are warned about before archiving", async () => {
      const result = await run(["x", "--skip-branch"], {
        runOpenSpec: withStatus({
          proposal: "done",
          specs: "done",
          design: "ready",
          tasks: "done",
        }),
      });
      expect(result.status).toBe("archived");
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: "incomplete-planning", artifacts: ["design"] }),
      ]);
      expect(err).toEqual([`warning: ${result.warnings[0].message}`]);
    });
  });

  test("a needs-branch run leaves warnings to the re-run that archives", async () => {
    await fs.writeFile(path.join(changeDir("x"), "proposal.md"), "---\ndependsOn: [a]\n---\n");
    await fs.mkdir(changeDir("a"), { recursive: true });
    const result = await run(["x"]);
    expect(result.status).toBe("needs-branch");
    expect(result.warnings).toHaveLength(1);
    expect(err).toEqual([]);
  });

  test("a failing OpenSpec archive exits non-zero after its warnings reached stderr", async () => {
    await fs.writeFile(path.join(changeDir("x"), "proposal.md"), "---\ndependsOn: [a]\n---\n");
    await fs.mkdir(changeDir("a"), { recursive: true });
    let shownBeforeArchive: string[] = [];
    const result = await run(["x", "--skip-branch"], {
      runOpenSpec: async (args) => {
        if (args[0] === "archive") shownBeforeArchive = [...err];
        return { code: 1, stdout: "", stderr: "tasks incomplete" };
      },
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.warnings).toHaveLength(1);
    expect(shownBeforeArchive).toEqual([`warning: ${result.warnings[0].message}`]);
    expect(process.exitCode).toBe(1);
  });

  test("without --json the result is rendered for people", async () => {
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(unlinkedRecord("x"), REPO, { branch: "change/x" }),
    );
    out = [];
    err = [];
    await runArtifactArchiveCommand(["x"], deps());
    expect(out).toEqual([
      "Archived x; publication waits until its delivery is merged (waiting).",
      `  ${REPO}  change/x  no merge recorded`,
      "  delivery: waiting",
    ]);
  });

  test("branch flags without an origin remote are refused and nothing is archived", async () => {
    out = [];
    err = [];
    await runArtifactArchiveCommand(
      ["x", "--branch", "change/x"],
      deps({ workingRepoGit: () => ({ ...repoGit(), remoteUrl: async () => null }) }),
    );
    expect(process.exitCode).toBe(1);
    expect(err[0]).toBe(
      "mate: the Working Repository has no origin remote to identify it; pass --repository <org/repo>.",
    );
    expect(archivedNames).toEqual([]);
  });

  test("--repository records the delivery when the Working Repository has no origin remote", async () => {
    const result = await run(["x", "--repository", REPO, "--branch", "change/x"], {
      workingRepoGit: () => ({ ...repoGit(), remoteUrl: async () => null }),
    });
    expect(result.status).toBe("archived");
    expect(result.record.deliveries[0]).toEqual({ repository: REPO, branch: "change/x" });
  });

  test("--repository without --branch or --not-applicable is refused", async () => {
    out = [];
    err = [];
    await runArtifactArchiveCommand(["x", "--repository", REPO], deps());
    expect(process.exitCode).toBe(1);
    expect(archivedNames).toEqual([]);
  });

  test("an archived or unknown change is refused", async () => {
    out = [];
    err = [];
    await runArtifactArchiveCommand(["nope"], deps());
    expect(process.exitCode).toBe(1);
    expect(err[0]).toContain("nope");
  });
});
