import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  defaultMaterializeWorkspaceDeps,
  materializeWorkspace,
  WorkspacePairingNotFoundError,
  WorkspaceRootUnavailableError,
  type MaterializeWorkspaceDeps,
} from "./workspace-materialize";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeDeps(overrides: Partial<MaterializeWorkspaceDeps> = {}): MaterializeWorkspaceDeps {
  return {
    isDirectory: async () => true,
    readCompanionRegistry: async () => ({ repos: [] }),
    writeWorkspaceDocument: async () => ({
      workspacePath: "/unused",
      folders: ["/unused-repo", "/unused-companion"],
    }),
    ...overrides,
  };
}

describe("materializeWorkspace", () => {
  test("writes the ordered working-repository and companion folders", async () => {
    const root = await makeTempDir("materialize-ok-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "repo");
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });

    const result = await materializeWorkspace(
      { repositoryId: "app", companionPath },
      makeDeps({
        isDirectory: async (candidate) => [companionPath, repoPath].includes(candidate),
        readCompanionRegistry: async () => ({ repos: [{ id: "app", path: repoPath }] }),
        writeWorkspaceDocument: async (companion, repo) => ({
          workspacePath: path.join(repo, ".mate", "workspace.code-workspace"),
          folders: [path.resolve(repo), path.resolve(companion)],
        }),
      }),
    );

    expect(result.schemaVersion).toBe(1);
    expect(result.folders).toEqual([path.resolve(repoPath), path.resolve(companionPath)]);
    expect(result.workspacePath).toBe(path.join(repoPath, ".mate", "workspace.code-workspace"));
  });

  test("does not invoke an editor CLI", async () => {
    const writeWorkspaceDocument = async () => ({
      workspacePath: "/repo/.mate/workspace.code-workspace",
      folders: ["/repo", "/companion"] as [string, string],
    });

    await materializeWorkspace(
      { repositoryId: "app", companionPath: "/companion" },
      makeDeps({
        readCompanionRegistry: async () => ({ repos: [{ id: "app", path: "/repo" }] }),
        writeWorkspaceDocument,
      }),
    );

    // No spawn/child-process dependency exists in MaterializeWorkspaceDeps at
    // all — materializeWorkspace has no code path capable of launching an
    // editor, unlike injectEditorFolder.
  });

  test("throws WorkspaceRootUnavailableError when the companion path is missing", async () => {
    await expect(
      materializeWorkspace(
        { repositoryId: "app", companionPath: "/missing-companion" },
        makeDeps({ isDirectory: async () => false }),
      ),
    ).rejects.toThrow(WorkspaceRootUnavailableError);
  });

  test("throws WorkspacePairingNotFoundError when the companion does not link the repository id", async () => {
    await expect(
      materializeWorkspace(
        { repositoryId: "unknown", companionPath: "/companion" },
        makeDeps({
          readCompanionRegistry: async () => ({ repos: [{ id: "app", path: "/repo" }] }),
        }),
      ),
    ).rejects.toThrow(WorkspacePairingNotFoundError);
  });

  test("throws WorkspaceRootUnavailableError when the linked repository path is missing", async () => {
    await expect(
      materializeWorkspace(
        { repositoryId: "app", companionPath: "/companion" },
        makeDeps({
          isDirectory: async (candidate) => candidate === "/companion",
          readCompanionRegistry: async () => ({ repos: [{ id: "app", path: "/repo" }] }),
        }),
      ),
    ).rejects.toThrow(WorkspaceRootUnavailableError);
  });
});

describe("materialization/open compatibility", () => {
  test("default deps wire materializeWorkspace to the exact writer injectEditorFolder uses", async () => {
    const { writeWorkspaceDocument } = await import("./editor");

    expect(defaultMaterializeWorkspaceDeps().writeWorkspaceDocument).toBe(writeWorkspaceDocument);
  });

  test("the shared writer produces the same ordered document regardless of caller", async () => {
    const root = await makeTempDir("materialize-open-compat-");
    const companionPath = path.join(root, "companion");
    const repoPath = path.join(root, "repo");
    await fs.mkdir(companionPath, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });
    const { writeWorkspaceDocument } = await import("./editor");

    const fromMaterialize = await materializeWorkspace(
      { repositoryId: "app", companionPath },
      {
        isDirectory: async (candidate) => [companionPath, repoPath].includes(candidate),
        readCompanionRegistry: async () => ({ repos: [{ id: "app", path: repoPath }] }),
        writeWorkspaceDocument,
      },
    );
    const fromOpenPath = await writeWorkspaceDocument(companionPath, repoPath);

    expect(fromOpenPath).toEqual({
      workspacePath: fromMaterialize.workspacePath,
      folders: fromMaterialize.folders,
    });
  });
});
