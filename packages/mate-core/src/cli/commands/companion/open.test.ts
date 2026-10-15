import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { writeRepoLocalRegistryEntry } from "../../../lib/orchestrator/repository-link";
import { WorkingRepoRequiredError } from "../../../lib/orchestrator/types";
import * as projection from "../../../lib/orchestrator/working-repo-projection";
import { launchAmbiguityDeps } from "../shared/companion-selection";
import { runWorkspaceOpenCommand, workspaceOpenCommandDeps } from "./open";

const originalDeps = { ...workspaceOpenCommandDeps };
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const tempRoots: string[] = [];

function match(companionPath: string) {
  return { companionPath, repositoryId: "repo-a" };
}

let injectEditorFolder: ReturnType<typeof mock>;

beforeEach(() => {
  injectEditorFolder = mock(async () => true);
  workspaceOpenCommandDeps.cwd = () => "/tmp/repo-a";
  workspaceOpenCommandDeps.findRepoRoot = async () => "/tmp/repo-a";
  workspaceOpenCommandDeps.resolveProjection = () => null;
  workspaceOpenCommandDeps.getPreferredEditorCli = () => "cursor";
  workspaceOpenCommandDeps.injectEditorFolder = injectEditorFolder as never;
  spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  mock.restore();
  Object.assign(workspaceOpenCommandDeps, originalDeps);
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  process.exitCode = 0;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runWorkspaceOpenCommand", () => {
  test("injects the working repo and its single companion into the preferred editor", async () => {
    workspaceOpenCommandDeps.resolveCompanions = async () => [match("/tmp/companion")];

    await runWorkspaceOpenCommand();

    expect(injectEditorFolder).toHaveBeenCalledWith(["/tmp/companion"], "/tmp/repo-a", "cursor");
  });

  test("passes every Linked Companion, sorted by resolved path", async () => {
    workspaceOpenCommandDeps.resolveCompanions = async () => [
      match("/tmp/companion-c"),
      match("/tmp/companion-a"),
      match("/tmp/companion-b"),
    ];

    await runWorkspaceOpenCommand();

    expect(injectEditorFolder).toHaveBeenCalledWith(
      ["/tmp/companion-a", "/tmp/companion-b", "/tmp/companion-c"],
      "/tmp/repo-a",
      "cursor",
    );
  });

  test("lists the projected companion right after the repository", async () => {
    workspaceOpenCommandDeps.resolveCompanions = async () => [
      match("/tmp/companion-a"),
      match("/tmp/companion-b"),
      match("/tmp/companion-c"),
    ];
    workspaceOpenCommandDeps.resolveProjection = () =>
      ({ companionPath: "/tmp/companion-b" }) as never;

    await runWorkspaceOpenCommand();

    expect(injectEditorFolder).toHaveBeenCalledWith(
      ["/tmp/companion-b", "/tmp/companion-a", "/tmp/companion-c"],
      "/tmp/repo-a",
      "cursor",
    );
  });

  test("ignores a projected companion that no longer links the repository", async () => {
    workspaceOpenCommandDeps.resolveCompanions = async () => [
      match("/tmp/companion-b"),
      match("/tmp/companion-a"),
    ];
    workspaceOpenCommandDeps.resolveProjection = () =>
      ({ companionPath: "/tmp/companion-gone" }) as never;

    await runWorkspaceOpenCommand();

    expect(injectEditorFolder).toHaveBeenCalledWith(
      ["/tmp/companion-a", "/tmp/companion-b"],
      "/tmp/repo-a",
      "cursor",
    );
  });

  test("MATE_ARTIFACT_PATH does not narrow the folder set", async () => {
    process.env.MATE_ARTIFACT_PATH = "/tmp/companion-a";
    workspaceOpenCommandDeps.resolveCompanions = async () => [
      match("/tmp/companion-a"),
      match("/tmp/companion-b"),
    ];

    await runWorkspaceOpenCommand();

    expect(injectEditorFolder).toHaveBeenCalledWith(
      ["/tmp/companion-a", "/tmp/companion-b"],
      "/tmp/repo-a",
      "cursor",
    );
  });

  test("never records a companion at the Projection Root", async () => {
    const projectWorkingRepository = spyOn(projection, "projectWorkingRepository");
    const projectBestEffort = spyOn(launchAmbiguityDeps, "projectWorkingRepository");
    workspaceOpenCommandDeps.resolveCompanions = async () => [
      match("/tmp/companion-a"),
      match("/tmp/companion-b"),
    ];

    await runWorkspaceOpenCommand();

    expect(projectWorkingRepository).not.toHaveBeenCalled();
    expect(projectBestEffort).not.toHaveBeenCalled();
  });

  test("sets exitCode 1 when the selected editor CLI is unavailable", async () => {
    workspaceOpenCommandDeps.resolveCompanions = async () => [match("/tmp/companion")];
    workspaceOpenCommandDeps.injectEditorFolder = async () => false;

    await runWorkspaceOpenCommand();

    expect(process.exitCode).toBe(1);
  });

  test("fails with the working-repo-required error when no companion links the repo", async () => {
    workspaceOpenCommandDeps.resolveCompanions = async () => [];

    await expect(runWorkspaceOpenCommand()).rejects.toThrow(WorkingRepoRequiredError);
    expect(injectEditorFolder).not.toHaveBeenCalled();
  });

  describe("with the real resolver", () => {
    async function makeLinkedRepo(companionNames: string[]) {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "open-stale-")));
      tempRoots.push(root);
      const repoPath = path.join(root, "working");
      const companionPaths = companionNames.map((name) => path.join(root, name));
      await Promise.all(
        [repoPath, ...companionPaths].map((dir) => fs.mkdir(dir, { recursive: true })),
      );
      for (const companionPath of companionPaths) {
        // oxlint-disable-next-line no-await-in-loop -- each link upserts the same registry file
        await writeRepoLocalRegistryEntry(
          repoPath,
          companionPath,
          { id: "app", path: repoPath },
          "git",
        );
      }
      return { repoPath, companionPaths };
    }

    function useRealResolver(repoPath: string) {
      Object.assign(workspaceOpenCommandDeps, {
        cwd: () => repoPath,
        findRepoRoot: originalDeps.findRepoRoot,
        resolveCompanions: originalDeps.resolveCompanions,
        resolveProjection: originalDeps.resolveProjection,
      });
    }

    function captureErrors(): string[] {
      const errors: string[] = [];
      spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.join(" "));
      });
      return errors;
    }

    const workspaceFile = (repoPath: string) =>
      path.join(repoPath, `.${FRAMEWORK_NAME}`, "workspace.code-workspace");

    test("skips a stale pointer with a warning and still opens the rest", async () => {
      const { repoPath, companionPaths } = await makeLinkedRepo(["companion-a", "companion-b"]);
      const [live, stale] = companionPaths as [string, string];
      await fs.rm(stale, { recursive: true });
      useRealResolver(repoPath);
      const errors = captureErrors();

      await runWorkspaceOpenCommand();

      expect(errors.join("\n")).toContain(stale);
      expect(injectEditorFolder).toHaveBeenCalledWith([live], repoPath, "cursor");
    });

    test("fails after warning when every pointer is stale, writing and spawning nothing", async () => {
      const { repoPath, companionPaths } = await makeLinkedRepo(["companion-a", "companion-b"]);
      await Promise.all(companionPaths.map((dir) => fs.rm(dir, { recursive: true })));
      useRealResolver(repoPath);
      const errors = captureErrors();

      await expect(runWorkspaceOpenCommand()).rejects.toThrow(WorkingRepoRequiredError);

      for (const companionPath of companionPaths) {
        expect(errors.join("\n")).toContain(companionPath);
      }
      expect(injectEditorFolder).not.toHaveBeenCalled();
      expect(await fs.stat(workspaceFile(repoPath)).catch(() => null)).toBeNull();
    });
  });
});
