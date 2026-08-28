import fs2 from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../framework";
import { runtimeDocumentDeps } from "../../lib/orchestrator/projection-runtime-documents";
import { writeRepoLocalRegistryEntry } from "../../lib/orchestrator/repo-local-registry";
import type { LinkedRepository } from "../../lib/orchestrator/types";
import { isWorkingRepositoryWrapped } from "../../lib/orchestrator/working-repo-projection";
import { runUnwrapCommand } from "./unwrap";
import { runWrapCommand } from "./wrap";

const tempRoots: string[] = [];
let originalExitCode: number | undefined;
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalHomeDir = runtimeDocumentDeps.homeDir;

beforeEach(() => {
  originalExitCode = process.exitCode;
  /** Cleared, not just remembered: a failure set by an earlier file is not this command's. */
  process.exitCode = 0;
  delete process.env.MATE_ARTIFACT_PATH;
  /** Local-scope MCP writes to the user's home; never the real one from a test. */
  const home = fs2.mkdtempSync(path.join(os.tmpdir(), "mate-unwrap-home-"));
  tempRoots.push(home);
  runtimeDocumentDeps.homeDir = () => home;
});

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
  process.exitCode = originalExitCode ?? 0;
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeLinkedRepo(prefix: string): Promise<{
  repoPath: string;
  companionPath: string;
  repository: LinkedRepository;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(companionPath, { recursive: true });
  const repository: LinkedRepository = { id: "app", path: repoPath };
  await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
  return { repoPath, companionPath, repository };
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => void out.push(args.map(String).join(" ")),
  );
  const errorSpy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => void err.push(args.map(String).join(" ")),
  );
  return {
    out,
    err,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

const exists = (candidate: string) =>
  fs
    .access(candidate)
    .then(() => true)
    .catch(() => false);

describe("runUnwrapCommand", () => {
  /**
   * The round trip the refusal in `FrameworkLauncher.prepare` reads: after a
   * wrap the repository is wrapped and a launch is refused, and after an unwrap
   * it is not, with the Repository Link intact so the launch resolves again.
   */
  test("withdraws what a wrap placed and leaves the link standing", async () => {
    const { repoPath } = await makeLinkedRepo("mate-unwrap-roundtrip-");

    const wrapped = capture();
    try {
      await runWrapCommand([], repoPath);
    } finally {
      wrapped.restore();
    }
    expect(await isWorkingRepositoryWrapped(repoPath)).toBe(true);

    const unwrapped = capture();
    try {
      await runUnwrapCommand([], repoPath);
    } finally {
      unwrapped.restore();
    }

    expect(process.exitCode ?? 0).toBe(0);
    expect(unwrapped.out.join("\n")).toContain("Unwrapped app");
    expect(unwrapped.out.join("\n")).toContain(`${FRAMEWORK_NAME} claude`);
    expect(await isWorkingRepositoryWrapped(repoPath)).toBe(false);

    /** Everything a Managed Session resolves through survived the unwrap. */
    const projectionDir = path.join(repoPath, `.${FRAMEWORK_NAME}`);
    expect(await exists(path.join(projectionDir, "config", "registry.yaml"))).toBe(true);
    expect(await exists(path.join(projectionDir, "config", "framework.yaml"))).toBe(true);
    expect(await exists(path.join(projectionDir, "projection.yaml"))).toBe(true);
    expect(await exists(projectionDir)).toBe(true);
  });

  test("reports a repository that was never wrapped without failing", async () => {
    const { repoPath } = await makeLinkedRepo("mate-unwrap-absent-");

    const captured = capture();
    try {
      await runUnwrapCommand([], repoPath);
    } finally {
      captured.restore();
    }

    expect(process.exitCode ?? 0).toBe(0);
    expect(captured.out.join("\n")).toContain("Not wrapped: app");
  });

  test("refuses a directory that is not a linked working repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-unwrap-unlinked-"));
    tempRoots.push(root);

    const captured = capture();
    try {
      await runUnwrapCommand([], root);
    } finally {
      captured.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(captured.err.join("\n")).toContain("not a working repository");
  });

  test("rejects arguments", async () => {
    const { repoPath } = await makeLinkedRepo("mate-unwrap-args-");

    const captured = capture();
    try {
      await runUnwrapCommand(["--all"], repoPath);
    } finally {
      captured.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(captured.err.join("\n")).toContain(`usage: ${FRAMEWORK_NAME} unwrap`);
  });
});
