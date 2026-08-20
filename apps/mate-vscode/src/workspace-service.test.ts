import { describe, expect, test } from "bun:test";

import { MateCliUnavailableError } from "./mate-cli-client";
import { WorkspaceService } from "./workspace-service";

describe("WorkspaceService.fetchInventory", () => {
  test("parses a successful mate workspace list response", async () => {
    const service = new WorkspaceService({
      options: () => ({}),
      runMateCli: async () => ({
        code: 0,
        stdout: JSON.stringify({ schemaVersion: 1, companions: [], pairings: [] }),
        stderr: "",
      }),
    });

    const inventory = await service.fetchInventory();

    expect(inventory).toEqual({ schemaVersion: 1, companions: [], pairings: [] });
  });

  test("throws with the CLI's stderr diagnostic on a non-zero exit", async () => {
    const service = new WorkspaceService({
      options: () => ({}),
      runMateCli: async () => ({ code: 1, stdout: "", stderr: "mate: something went wrong" }),
    });

    await expect(service.fetchInventory()).rejects.toThrow("mate: something went wrong");
  });
});

describe("WorkspaceService.materialize", () => {
  test("passes the repository id and companion path through to the CLI args", async () => {
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const service = new WorkspaceService({
      options: () => ({ cwd: "/somewhere" }),
      runMateCli: async (args, options) => {
        calls.push({ args, options });
        return {
          code: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            workspacePath: "/repo/.mate/workspace.code-workspace",
            folders: ["/repo", "/companion"],
          }),
          stderr: "",
        };
      },
    });

    await service.materialize({ repositoryId: "app", companionPath: "/companion" });

    expect(calls).toEqual([
      {
        args: [
          "workspace",
          "materialize",
          "--repository",
          "app",
          "--companion",
          "/companion",
          "--json",
        ],
        options: { cwd: "/somewhere" },
      },
    ]);
  });
});

describe("WorkspaceService.resolveSessionEnvelope", () => {
  test("passes workspace context and selection through the JSON boundary", async () => {
    const calls: string[][] = [];
    const service = new WorkspaceService({
      options: () => ({ cwd: "/repos/app" }),
      runMateCli: async (args) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            status: "resolved",
            diagnostics: [],
            envelope: {
              schemaVersion: 1,
              host: "mate.chat",
              repositoryLink: {
                schemaVersion: 1,
                repository: { id: "app", path: "/repos/app" },
                companionPath: "/companions/a",
              },
              workingRepositoryPath: "/repos/app",
              companionRepositoryPath: "/companions/a",
              capabilities: [],
              renderedGuidance: "guidance",
              permittedRoots: ["/repos/app", "/companions/a"],
            },
          }),
          stderr: "",
        };
      },
    });

    await service.resolveSessionEnvelope({
      host: "mate.chat",
      cwd: "/repos/app",
      activePath: "/repos/app/index.ts",
      workspaceRoots: ["/repos/app"],
      repositoryId: "app",
      repositoryPath: "/repos/app",
      companionPath: "/companions/a",
    });

    expect(calls).toEqual([
      [
        "workspace",
        "resolve",
        "--json",
        "--host",
        "mate.chat",
        "--cwd",
        "/repos/app",
        "--active",
        "/repos/app/index.ts",
        "--workspace-root",
        "/repos/app",
        "--companion",
        "/companions/a",
        "--repository",
        "app",
        "--repository-path",
        "/repos/app",
      ],
    ]);
  });
});

describe("WorkspaceService.isMateAvailable", () => {
  test("returns false when the CLI cannot be spawned", async () => {
    const service = new WorkspaceService({
      options: () => ({}),
      runMateCli: async () => {
        throw new MateCliUnavailableError("not found");
      },
    });

    expect(await service.isMateAvailable()).toBe(false);
  });

  test("returns true when mate --version succeeds", async () => {
    const service = new WorkspaceService({
      options: () => ({}),
      runMateCli: async () => ({ code: 0, stdout: "0.1.0", stderr: "" }),
    });

    expect(await service.isMateAvailable()).toBe(true);
  });

  test("re-throws an unrelated error rather than reporting mate as merely unavailable", async () => {
    const service = new WorkspaceService({
      options: () => ({}),
      runMateCli: async () => {
        throw new Error("unexpected");
      },
    });

    await expect(service.isMateAvailable()).rejects.toThrow("unexpected");
  });
});
