import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type {
  SessionEnvelopeRequest,
  SessionEnvelopeResolution,
} from "../../../lib/orchestrator/session-envelope";
import { runWorkspaceResolveCommand, workspaceResolveCommandDeps } from "./resolve";

const originalResolve = workspaceResolveCommandDeps.resolveSessionEnvelope;

afterEach(() => {
  workspaceResolveCommandDeps.resolveSessionEnvelope = originalResolve;
  process.exitCode = 0;
});

describe("runWorkspaceResolveCommand", () => {
  test("requires --json before resolving", async () => {
    workspaceResolveCommandDeps.resolveSessionEnvelope = async () => {
      throw new Error("must not resolve without JSON mode");
    };

    await runWorkspaceResolveCommand([]);

    expect(process.exitCode).toBe(1);
  });

  test("passes host context and explicit selection to the resolver", async () => {
    let request: SessionEnvelopeRequest | undefined;
    const result: SessionEnvelopeResolution = {
      schemaVersion: 1,
      status: "resolved",
      diagnostics: [],
      envelope: {
        schemaVersion: 1,
        host: "vscode-chat",
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
    };
    workspaceResolveCommandDeps.resolveSessionEnvelope = async (value) => {
      request = value;
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
      await runWorkspaceResolveCommand([
        "--json",
        "--host",
        "vscode-chat",
        "--cwd",
        "/repos/app/src",
        "--active",
        "/repos/app/src/index.ts",
        "--workspace-root",
        "/repos/app",
        "--companion",
        "/companions/a",
        "--repository",
        "app",
        "--repository-path",
        "/repos/app",
      ]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(request).toEqual({
      host: "vscode-chat",
      cwd: "/repos/app/src",
      activePath: "/repos/app/src/index.ts",
      workspaceRoots: ["/repos/app"],
      selection: {
        companionPath: "/companions/a",
        repositoryId: "app",
        repositoryPath: "/repos/app",
      },
    });
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!)).toEqual(result);
    expect(process.exitCode).toBe(0);
  });

  test("writes a versioned diagnostic result without invoking a runtime", async () => {
    let runtimeCalls = 0;
    workspaceResolveCommandDeps.resolveSessionEnvelope = async () => ({
      schemaVersion: 1,
      status: "diagnostic",
      diagnostics: [
        {
          code: "selection-required",
          message: "select a link",
          candidates: [],
        },
      ],
    });
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: unknown, callback?: (error?: Error | null) => void) => {
        runtimeCalls += String(chunk).includes("selection-required") ? 0 : 1;
        (typeof callback === "function" ? callback : undefined)?.(null);
        return true;
      },
    );

    try {
      await runWorkspaceResolveCommand(["--json"]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(runtimeCalls).toBe(0);
    expect(process.exitCode).toBe(0);
  });
});
