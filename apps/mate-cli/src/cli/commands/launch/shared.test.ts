import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  ensureUnambiguousCompanion,
  launchAmbiguityDeps,
  parseDirectLaunchArgs,
  parseLaunchArgs,
} from "./shared";

let originalExitCode: number | undefined;
const originalResolveCompanionMatches = launchAmbiguityDeps.resolveCompanionMatches;
const originalSelectCompanion = launchAmbiguityDeps.selectCompanion;
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalRepoId = process.env.MATE_REPO_ID;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.stdout.isTTY = true;
});

afterEach(() => {
  // Bun keeps a non-zero exitCode unless it is explicitly reset.
  process.exitCode = originalExitCode ?? 0;
  launchAmbiguityDeps.resolveCompanionMatches = originalResolveCompanionMatches;
  launchAmbiguityDeps.selectCompanion = originalSelectCompanion;
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  if (originalRepoId === undefined) delete process.env.MATE_REPO_ID;
  else process.env.MATE_REPO_ID = originalRepoId;
  process.stdin.isTTY = originalStdinIsTTY;
  process.stdout.isTTY = originalStdoutIsTTY;
});

describe("parseLaunchArgs", () => {
  test("parses tool args after the -- separator", () => {
    expect(parseLaunchArgs(["--", "--model", "gpt-5"])).toEqual({
      agentArgs: ["--model", "gpt-5"],
    });
  });

  test("returns empty agent args when no separator is present", () => {
    expect(parseLaunchArgs([])).toEqual({ agentArgs: [] });
  });

  test("consumes --no-git only after the launch separator", () => {
    expect(parseLaunchArgs(["--", "--model", "gpt-5", "--no-git", "--verbose"])).toEqual({
      agentArgs: ["--model", "gpt-5", "--verbose"],
      skipGit: true,
    });
  });

  test("does not consume --no-git as a launch option before the separator", () => {
    expect(parseLaunchArgs(["--no-git"])).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  test("returns null for unknown launch options", () => {
    expect(parseLaunchArgs(["--bogus"])).toBeNull();
    expect(process.exitCode).toBe(1);
  });
});

describe("parseDirectLaunchArgs", () => {
  test("passes through top-level launch args without requiring a separator", () => {
    expect(parseDirectLaunchArgs(["--session", "abc123"])).toEqual({
      agentArgs: ["--session", "abc123"],
    });
  });

  test("consumes the bypass token while preserving direct passthrough args", () => {
    expect(parseDirectLaunchArgs(["--model", "gpt-5", "--", "--no-git", "--verbose"])).toEqual({
      agentArgs: ["--model", "gpt-5", "--verbose"],
      skipGit: true,
    });
  });

  test("forwards --no-git when it is not after a separator", () => {
    expect(parseDirectLaunchArgs(["--no-git"])).toEqual({ agentArgs: ["--no-git"] });
  });
});

describe("ensureUnambiguousCompanion", () => {
  test("returns true immediately when MATE_ARTIFACT_PATH is already set", async () => {
    process.env.MATE_ARTIFACT_PATH = "/tmp/pinned-companion";
    launchAmbiguityDeps.resolveCompanionMatches = mock(async () => {
      throw new Error("should not be called");
    });

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
  });

  test("can reselect when a pinned companion hides multiple matches", async () => {
    process.env.MATE_ARTIFACT_PATH = "/tmp/pinned-companion";
    delete process.env.MATE_REPO_ID;
    process.stdin.isTTY = true;
    launchAmbiguityDeps.resolveCompanionMatches = mock(async () => [
      { companionPath: "/tmp/companion-a", repositoryId: "from-a" },
      { companionPath: "/tmp/companion-b", repositoryId: "from-b" },
    ]);
    launchAmbiguityDeps.selectCompanion = mock(async () => ({
      companionPath: "/tmp/companion-b",
      repositoryId: "from-b",
    }));

    expect(await ensureUnambiguousCompanion("/tmp/repo", { reselect: true })).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-b");
    expect(process.env.MATE_REPO_ID).toBe("from-b");
  });

  test("returns true when there is no ambiguity", async () => {
    delete process.env.MATE_ARTIFACT_PATH;
    launchAmbiguityDeps.resolveCompanionMatches = mock(async () => []);

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
  });

  test("prints guidance and returns false outside a TTY when ambiguous", async () => {
    delete process.env.MATE_ARTIFACT_PATH;
    process.stdin.isTTY = false;
    launchAmbiguityDeps.resolveCompanionMatches = mock(async () => [
      { companionPath: "/tmp/companion-a", repositoryId: "from-a" },
      { companionPath: "/tmp/companion-b", repositoryId: "from-b" },
    ]);
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(false);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(chunks.join("")).toContain("linked from multiple companions");
    expect(chunks.join("")).toContain("/tmp/companion-a");
    expect(chunks.join("")).toContain("/tmp/companion-b");
  });

  test("pins the chosen companion via env vars when the user picks one in a TTY", async () => {
    delete process.env.MATE_ARTIFACT_PATH;
    delete process.env.MATE_REPO_ID;
    process.stdin.isTTY = true;
    launchAmbiguityDeps.resolveCompanionMatches = mock(async () => [
      { companionPath: "/tmp/companion-a", repositoryId: "from-a" },
      { companionPath: "/tmp/companion-b", repositoryId: "from-b" },
    ]);
    launchAmbiguityDeps.selectCompanion = mock(async () => ({
      companionPath: "/tmp/companion-b",
      repositoryId: "from-b",
    }));

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-b");
    expect(process.env.MATE_REPO_ID).toBe("from-b");
  });

  test("preserves the pinned repository id when MATE_ARTIFACT_PATH is already set", async () => {
    process.env.MATE_ARTIFACT_PATH = "/tmp/pinned-companion";
    process.env.MATE_REPO_ID = "already-pinned";
    launchAmbiguityDeps.resolveCompanionMatches = mock(async () => {
      throw new Error("should not be called");
    });

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/pinned-companion");
    expect(process.env.MATE_REPO_ID).toBe("already-pinned");
  });

  test("returns false when the user cancels the picker", async () => {
    delete process.env.MATE_ARTIFACT_PATH;
    process.stdin.isTTY = true;
    launchAmbiguityDeps.resolveCompanionMatches = mock(async () => [
      { companionPath: "/tmp/companion-a", repositoryId: "from-a" },
      { companionPath: "/tmp/companion-b", repositoryId: "from-b" },
    ]);
    launchAmbiguityDeps.selectCompanion = mock(async () => null);

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(false);
  });
});
