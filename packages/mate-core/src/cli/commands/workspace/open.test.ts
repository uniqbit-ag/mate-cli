import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { WorkingRepoRequiredError } from "../../../lib/orchestrator/types";
import { runWorkspaceOpenCommand, workspaceOpenCommandDeps } from "./open";

const originalEnsureUnambiguousCompanion = workspaceOpenCommandDeps.ensureUnambiguousCompanion;
const originalResolveLaunchContext = workspaceOpenCommandDeps.resolveLaunchContext;
const originalCreateStore = workspaceOpenCommandDeps.createStore;
const originalGetPreferredEditorCli = workspaceOpenCommandDeps.getPreferredEditorCli;
const originalInjectEditorFolder = workspaceOpenCommandDeps.injectEditorFolder;

beforeEach(() => {
  workspaceOpenCommandDeps.ensureUnambiguousCompanion = async () => true;
});

afterEach(() => {
  mock.restore();
  workspaceOpenCommandDeps.ensureUnambiguousCompanion = originalEnsureUnambiguousCompanion;
  workspaceOpenCommandDeps.resolveLaunchContext = originalResolveLaunchContext;
  workspaceOpenCommandDeps.createStore = originalCreateStore;
  workspaceOpenCommandDeps.getPreferredEditorCli = originalGetPreferredEditorCli;
  workspaceOpenCommandDeps.injectEditorFolder = originalInjectEditorFolder;
  process.exitCode = 0;
});

describe("runWorkspaceOpenCommand", () => {
  test("injects the linked working repo and companion into the preferred editor", async () => {
    const injectEditorFolder = mock(async () => true);

    workspaceOpenCommandDeps.resolveLaunchContext = async () =>
      ({
        companionPath: "/tmp/companion",
        repositoryId: "repo-a",
        configStore: {},
        workingRepoStore: {},
      }) as never;
    workspaceOpenCommandDeps.createStore = () =>
      ({
        getRepository: async (id: string) =>
          id === "repo-a" ? { id: "repo-a", path: "/tmp/repo-a", profile: "default" } : undefined,
      }) as never;
    workspaceOpenCommandDeps.getPreferredEditorCli = () => "cursor";
    workspaceOpenCommandDeps.injectEditorFolder = injectEditorFolder;

    await runWorkspaceOpenCommand();

    expect(injectEditorFolder).toHaveBeenCalledWith("/tmp/companion", "/tmp/repo-a", "cursor");
  });

  test("sets exitCode 1 when the selected editor CLI is unavailable", async () => {
    workspaceOpenCommandDeps.resolveLaunchContext = async () =>
      ({
        companionPath: "/tmp/companion",
        repositoryId: "repo-a",
        configStore: {},
        workingRepoStore: {},
      }) as never;
    workspaceOpenCommandDeps.createStore = () =>
      ({
        getRepository: async () => ({ id: "repo-a", path: "/tmp/repo-a", profile: "default" }),
      }) as never;
    workspaceOpenCommandDeps.getPreferredEditorCli = () => "code";
    workspaceOpenCommandDeps.injectEditorFolder = async () => false;

    await runWorkspaceOpenCommand();

    expect(process.exitCode).toBe(1);
  });

  test("preserves working-repo context errors", async () => {
    workspaceOpenCommandDeps.resolveLaunchContext = async () => {
      throw new WorkingRepoRequiredError("companion open");
    };

    await expect(runWorkspaceOpenCommand()).rejects.toThrow(WorkingRepoRequiredError);
  });

  test("throws when the active repository id cannot be resolved", async () => {
    workspaceOpenCommandDeps.resolveLaunchContext = async () =>
      ({
        companionPath: "/tmp/companion",
        repositoryId: "missing",
        configStore: {},
        workingRepoStore: {},
      }) as never;
    workspaceOpenCommandDeps.createStore = () =>
      ({
        getRepository: async () => undefined,
      }) as never;
    workspaceOpenCommandDeps.injectEditorFolder = mock(async () => true);

    await expect(runWorkspaceOpenCommand()).rejects.toThrow("Linked repository not found: missing");
  });

  test("sets exitCode 1 and skips injection when the companion is ambiguous", async () => {
    const resolveLaunchContext = mock(async () => ({}) as never);
    const injectEditorFolder = mock(async () => true);

    workspaceOpenCommandDeps.ensureUnambiguousCompanion = async () => false;
    workspaceOpenCommandDeps.resolveLaunchContext = resolveLaunchContext;
    workspaceOpenCommandDeps.injectEditorFolder = injectEditorFolder;

    await runWorkspaceOpenCommand();

    expect(process.exitCode).toBe(1);
    expect(resolveLaunchContext).not.toHaveBeenCalled();
    expect(injectEditorFolder).not.toHaveBeenCalled();
  });
});
