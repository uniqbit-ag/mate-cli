import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { WorkspacePairingNotFoundError } from "../../../lib/orchestrator/workspace-materialize";
import { runWorkspaceMaterializeCommand, workspaceMaterializeCommandDeps } from "./materialize";

const originalMaterializeWorkspace = workspaceMaterializeCommandDeps.materializeWorkspace;

afterEach(() => {
  workspaceMaterializeCommandDeps.materializeWorkspace = originalMaterializeWorkspace;
  process.exitCode = 0;
});

describe("runWorkspaceMaterializeCommand", () => {
  test("requires --repository, --companion, and --json", async () => {
    const materialize = () => {
      throw new Error("must not be called with missing flags");
    };
    workspaceMaterializeCommandDeps.materializeWorkspace = materialize;

    await runWorkspaceMaterializeCommand(["--repository", "app"]);

    expect(process.exitCode).toBe(1);
  });

  test("prints exactly one JSON document on success", async () => {
    const result = {
      schemaVersion: 1 as const,
      workspacePath: "/repo/.mate/workspace.code-workspace",
      folders: ["/repo", "/companion"] as [string, string],
    };
    workspaceMaterializeCommandDeps.materializeWorkspace = async (repositoryId, companionPath) => {
      expect(repositoryId).toBe("app");
      expect(companionPath).toBe("/companion");
      return result;
    };
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: unknown, callback?: (error?: Error | null) => void) => {
        chunks.push(String(chunk));
        (typeof callback === "function" ? callback : undefined)?.(null);
        return true;
      },
    );

    try {
      await runWorkspaceMaterializeCommand([
        "--repository",
        "app",
        "--companion",
        "/companion",
        "--json",
      ]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!)).toEqual(result);
    expect(process.exitCode).toBe(0);
  });

  test("reports a machine-readable diagnostic and exits non-zero when the pairing cannot be resolved", async () => {
    workspaceMaterializeCommandDeps.materializeWorkspace = async () => {
      throw new WorkspacePairingNotFoundError("app", "/companion");
    };
    const errors: string[] = [];
    const errorSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string) => {
      errors.push(chunk);
      return true;
    });

    try {
      await runWorkspaceMaterializeCommand([
        "--repository",
        "app",
        "--companion",
        "/companion",
        "--json",
      ]);
    } finally {
      errorSpy.mockRestore();
    }

    expect(process.exitCode).toBe(1);
    expect(errors.join("")).toContain("app");
  });
});
