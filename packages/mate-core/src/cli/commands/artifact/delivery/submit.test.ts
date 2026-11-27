import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkingRepoGit } from "../../../../lib/delivery/branches";
import {
  unlinkedRecord,
  upsertDelivery,
  writeDeliveryRecord,
} from "../../../../lib/delivery/record";
import type { DropResult, GroupSubmission } from "../../../../lib/delivery/staging/submit";
import type { SubmitResult } from "../../../../lib/delivery/submit-change";
import type { RunOpenSpec } from "../../../../lib/openspec-cli";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import { ARCHIVE_ALIAS_NOTE, ARCHIVE_DEPRECATION, runArtifactArchiveCommand } from "./archive";
import { runArtifactSubmitCommand, type SubmitCommandDeps } from "./submit";

const REPO = "acme/acme-app";
let companion: string;
let out: string[];
let err: string[];
let pushed: string[][];

const changeDir = (name: string) => path.join(companion, "openspec", "changes", name);

function repoGit(existing: string[] = []): WorkingRepoGit {
  return {
    currentBranch: async () => "change/x",
    defaultBranch: async () => "main",
    remoteUrl: async () => "https://github.com/acme/acme-app.git",
    unpushedCommits: async () => [],
    branchExists: async (branch) => existing.includes(branch),
    hasRef: async (ref) => existing.some((branch) => ref === `refs/heads/${branch}`),
  };
}

/** `validate` fails for `invalid`; `status` is unreadable. */
function openSpec(invalid: string[] = []): RunOpenSpec {
  return async (args) => {
    if (args[0] === "validate" && invalid.includes(args.at(-1)!)) {
      return { code: 1, stdout: "", stderr: "invalid delta" };
    }
    return args[0] === "status"
      ? { code: 1, stdout: "", stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
  };
}

function groups(
  status: GroupSubmission["status"],
  group = "change/x",
): SubmitCommandDeps["submitGroups"] {
  return async (_companion, names) => {
    pushed.push([...names]);
    return [
      {
        group,
        status,
        waitingFor: [],
        push: {
          group,
          changes: [...names],
          status: status === "failed" ? "failed" : "pushed",
          commit: status === "pushed" ? "c0ffee" : null,
          pendingBranch: "mate/inbox",
          ...(status === "failed" ? { reason: "push-failed" as const, detail: "offline" } : {}),
        },
      },
    ];
  };
}

function deps(overrides: Partial<SubmitCommandDeps> = {}): SubmitCommandDeps {
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
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    runOpenSpec: openSpec(),
    submitGroups: groups("pushed"),
    preflightGroup: async () => ({ status: "passed" }),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
}

async function run(
  argv: string[],
  overrides: Partial<SubmitCommandDeps> = {},
): Promise<SubmitResult[]> {
  out = [];
  err = [];
  await runArtifactSubmitCommand([...argv, "--json"], deps(overrides));
  return JSON.parse(out[0]!) as SubmitResult[];
}

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-submit-"));
  await fs.mkdir(changeDir("x"), { recursive: true });
  // Every task checked, so no stage before submit is open.
  await fs.writeFile(path.join(changeDir("x"), "tasks.md"), "- [x] 1.1 Acme\n");
  pushed = [];
  process.exitCode = 0;
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("mate artifact submit", () => {
  test("--skip-branch submits with an unlinked record and pushes its group", async () => {
    const [result] = await run(["x", "--skip-branch"]);
    expect(result).toMatchObject({
      change: "x",
      status: "submitted",
      group: "change/x",
      waitingFor: [],
      pushed: true,
      commit: "c0ffee",
      pendingBranch: "mate/inbox",
      state: "submitted",
    });
    expect(pushed).toEqual([["x"]]);
    expect(process.exitCode).toBe(0);
  });

  test("a waiting group is an answer, not a refusal, and changes no state", async () => {
    const [result] = await run(["x", "--skip-branch"], { submitGroups: groups("waiting") });
    expect(result).toMatchObject({ status: "waiting", state: "active", pushed: false });
    expect(process.exitCode).toBe(0);
  });

  test("an unlinked change is not submitted; the existing default branch is suggested", async () => {
    const [result] = await run(["x"], { workingRepoGit: () => repoGit(["change/x"]) });
    expect(result).toMatchObject({ status: "needs-branch", suggestedBranch: "change/x" });
    expect(pushed).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("a failed check exits non-zero after its warnings reached stderr", async () => {
    await fs.writeFile(path.join(changeDir("x"), "proposal.md"), "---\ndependsOn: [a]\n---\n");
    await fs.mkdir(changeDir("a"), { recursive: true });
    const [result] = await run(["x", "--skip-branch"], { runOpenSpec: openSpec(["x"]) });
    expect(result).toMatchObject({ status: "failed", reason: "check-failed" });
    expect(err).toEqual([`warning: ${result!.warnings[0]!.message}`, result!.message]);
    expect(out).toEqual([JSON.stringify([result])]);
    expect(pushed).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("without --json a failed result's lines go to stderr, not stdout", async () => {
    out = [];
    err = [];
    await runArtifactSubmitCommand(["x", "--skip-branch"], deps({ runOpenSpec: openSpec(["x"]) }));
    expect(out).toEqual([]);
    expect(err.some((line) => line.startsWith("  delivery: "))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("a failed push exits non-zero and leaves the change active", async () => {
    const [result] = await run(["x", "--skip-branch"], { submitGroups: groups("failed") });
    expect(result).toMatchObject({ status: "failed", reason: "push-failed", state: "active" });
    expect(process.exitCode).toBe(1);
  });

  test("the default branch is accepted only as an explicit direct delivery", async () => {
    out = [];
    err = [];
    await runArtifactSubmitCommand(["x", "--branch", "main", "--json"], deps());
    expect(process.exitCode).toBe(1);
    expect(pushed).toEqual([]);
  });

  test("without --json the result is rendered for people", async () => {
    await writeDeliveryRecord(
      changeDir("x"),
      upsertDelivery(unlinkedRecord("x"), REPO, { branch: "change/x" }),
    );
    out = [];
    err = [];
    await runArtifactSubmitCommand(
      ["x"],
      deps({ submitGroups: groups("pushed", "acme_acme-app/change/x") }),
    );
    expect(out).toEqual([
      "Submitted x: pushed group acme_acme-app/change/x to mate/inbox; it publishes once its delivery is merged.",
      `  ${REPO}  change/x  no merge recorded`,
      `  change/x: ${REPO} is not linked on this machine; needs an answer`,
      "  delivery: waiting",
    ]);
  });

  test("an unknown change is refused", async () => {
    out = [];
    err = [];
    await runArtifactSubmitCommand(["nope"], deps());
    expect(process.exitCode).toBe(1);
    expect(err[0]).toBe('mate: no active change named "nope" to submit.');
  });

  test("--drop drops each named change", async () => {
    const dropped: string[] = [];
    out = [];
    err = [];
    await runArtifactSubmitCommand(
      ["x", "acme-gone", "--drop", "--json"],
      deps({
        dropSubmitted: async (_companion, change): Promise<DropResult> => {
          dropped.push(change);
          return change === "x"
            ? {
                change,
                status: "dropped",
                group: "change/x",
                pushed: true,
                commit: "c",
                message: "",
              }
            : {
                change,
                status: "refused",
                group: null,
                pushed: false,
                commit: null,
                reason: "missing",
                message: "",
              };
        },
      }),
    );
    expect(dropped).toEqual(["x", "acme-gone"]);
    expect((JSON.parse(out[0]!) as DropResult[]).map((result) => result.status)).toEqual([
      "dropped",
      "refused",
    ]);
    expect(process.exitCode).toBe(1);
  });
});

describe("mate artifact archive", () => {
  test("records and checks with a one-line deprecation note, and never pushes", async () => {
    out = [];
    err = [];
    await runArtifactArchiveCommand(["x", "--skip-branch", "--json"], deps());
    expect(err).toEqual([ARCHIVE_DEPRECATION]);
    expect(JSON.parse(out[0]!) as SubmitResult).toMatchObject({
      change: "x",
      status: "waiting",
      waitingFor: [],
      state: "active",
    });
    expect(pushed).toEqual([]);
  });

  test("refuses --drop, which would push", async () => {
    out = [];
    err = [];
    let dropped = false;
    await runArtifactArchiveCommand(
      ["x", "--drop"],
      deps({
        dropSubmitted: async () => {
          dropped = true;
          throw new Error("unreachable");
        },
      }),
    );
    expect(dropped).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test("--json answers one change with one object whose message explains the alias", async () => {
    out = [];
    err = [];
    await runArtifactArchiveCommand(["x", "--skip-branch", "--json"], deps());
    const result = JSON.parse(out[0]!) as SubmitResult;
    expect(Array.isArray(result)).toBe(false);
    expect(result.status).toBe("waiting");
    expect(result.message).toBe(`Checked x; nothing was pushed.\n${ARCHIVE_ALIAS_NOTE}`);
  });

  test("--json with several changes keeps submit's array", async () => {
    await fs.mkdir(changeDir("y"), { recursive: true });
    out = [];
    err = [];
    const submitGroups: SubmitCommandDeps["submitGroups"] = async (dir, _names, options) => [
      ...(await groups("pushed", "change/x")!(dir, ["x"], options)),
      ...(await groups("pushed", "change/y")!(dir, ["y"], options)),
    ];
    await runArtifactArchiveCommand(["x", "y", "--skip-branch", "--json"], deps({ submitGroups }));
    expect((JSON.parse(out[0]!) as SubmitResult[]).map((result) => result.change)).toEqual([
      "x",
      "y",
    ]);
  });
});
