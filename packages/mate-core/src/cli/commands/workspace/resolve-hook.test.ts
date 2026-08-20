import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { SessionEnvelopeResolution } from "../../../lib/orchestrator/session-envelope";
import { runWorkspaceResolveHookCommand, workspaceResolveHookCommandDeps } from "./resolve-hook";

const originalResolve = workspaceResolveHookCommandDeps.resolveSessionEnvelope;
const originalAppend = workspaceResolveHookCommandDeps.appendEnvironment;
const originalEnvironment = { ...process.env };

const envelope = {
  schemaVersion: 1 as const,
  host: "claude-code",
  repositoryLink: {
    schemaVersion: 1 as const,
    repository: { id: "app", path: "/repos/app" },
    companionPath: "/companions/a",
  },
  workingRepositoryPath: "/repos/app",
  companionRepositoryPath: "/companions/a",
  capabilities: [],
  renderedGuidance: "guidance",
  permittedRoots: ["/repos/app", "/companions/a"],
};

afterEach(() => {
  workspaceResolveHookCommandDeps.resolveSessionEnvelope = originalResolve;
  workspaceResolveHookCommandDeps.appendEnvironment = originalAppend;
  process.exitCode = 0;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe("runWorkspaceResolveHookCommand", () => {
  test("injects resolved context and persists the selected link", async () => {
    const writes: Array<{ envFile: string; entries: Record<string, string> }> = [];
    let request: unknown;
    workspaceResolveHookCommandDeps.resolveSessionEnvelope = async (value) => {
      request = value;
      return { schemaVersion: 1, status: "resolved", envelope, diagnostics: [] };
    };
    workspaceResolveHookCommandDeps.appendEnvironment = async (envFile, entries) => {
      writes.push({ envFile, entries });
    };
    process.env.CLAUDE_ENV_FILE = "/tmp/claude-env";
    delete process.env.MATE_ARTIFACT_PATH;
    delete process.env.MATE_REPO_PATH;
    delete process.env.MATE_REPO_ID;
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: unknown, callback?: (error?: Error | null) => void) => {
        chunks.push(String(chunk));
        callback?.(null);
        return true;
      },
    );

    try {
      await runWorkspaceResolveHookCommand(["--event", "SessionStart"]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(request).toMatchObject({ host: "claude-code", cwd: process.cwd() });
    expect(writes).toEqual([
      {
        envFile: "/tmp/claude-env",
        entries: {
          MATE_REPO_PATH: "/repos/app",
          MATE_ARTIFACT_PATH: "/companions/a",
          MATE_REPO_ID: "app",
        },
      },
    ]);
    expect(JSON.parse(chunks[0]!)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("/companions/a"),
      },
    });
  });

  test("reports ambiguity to Claude without persisting an arbitrary candidate", async () => {
    const result: SessionEnvelopeResolution = {
      schemaVersion: 1,
      status: "diagnostic",
      diagnostics: [
        {
          code: "selection-required",
          message: "select a link",
          candidates: [envelope.repositoryLink],
        },
      ],
    };
    let writes = 0;
    workspaceResolveHookCommandDeps.resolveSessionEnvelope = async () => result;
    workspaceResolveHookCommandDeps.appendEnvironment = async () => {
      writes += 1;
    };
    delete process.env.CLAUDE_ENV_FILE;
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: unknown, callback?: (error?: Error | null) => void) => {
        chunks.push(String(chunk));
        callback?.(null);
        return true;
      },
    );

    try {
      await runWorkspaceResolveHookCommand(["--event", "UserPromptSubmit"]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(writes).toBe(0);
    expect(JSON.parse(chunks[0]!)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("select a link"),
      },
    });
  });
});
