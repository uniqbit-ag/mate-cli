import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  ensureUnambiguousCompanion,
  launchAmbiguityDeps,
  launchCommandDeps,
  parseDirectLaunchArgs,
  parseLaunchArgs,
  runLaunchToolCommand,
} from "./shared";
import { LaunchPreflightError, type LaunchRequest } from "../../../lib/orchestrator/types";

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

describe("runLaunchToolCommand", () => {
  test("passes a two-stream TTY capability and stops progress before preparation", async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const events: string[] = [];
    const requests: LaunchRequest[] = [];
    const originalCreateLauncher = launchCommandDeps.createLauncher;
    const originalCreateProgress = launchCommandDeps.createProgress;
    const originalRunIndexCapCommand = launchCommandDeps.runIndexCapCommand;

    launchCommandDeps.createLauncher = () => ({
      prepare: async (request) => {
        events.push("prepare");
        requests.push(request);
        return {
          execute: async () => {
            events.push("execute");
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        };
      },
    });
    launchCommandDeps.createProgress = () => ({
      start: () => events.push("progress:start"),
      succeed: () => events.push("progress:succeed"),
      fail: () => events.push("progress:fail"),
      failCurrent: () => events.push("progress:fail-current"),
      stop: () => events.push("progress:stop"),
    });
    launchCommandDeps.runIndexCapCommand = async () => {
      events.push("index");
    };

    try {
      await runLaunchToolCommand("claude", [], { skipConfirmation: true });
    } finally {
      launchCommandDeps.createLauncher = originalCreateLauncher;
      launchCommandDeps.createProgress = originalCreateProgress;
      launchCommandDeps.runIndexCapCommand = originalRunIndexCapCommand;
    }

    expect(requests[0]?.interactiveGit).toBe(true);
    expect(events.indexOf("progress:stop")).toBeLessThan(events.indexOf("prepare"));
    expect(events).toContain("execute");
  });

  test("uses captured Git mode and blocks launch failures without a two-stream TTY", async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = false;
    const requests: LaunchRequest[] = [];
    const originalCreateLauncher = launchCommandDeps.createLauncher;
    const originalCreateProgress = launchCommandDeps.createProgress;
    const originalRunIndexCapCommand = launchCommandDeps.runIndexCapCommand;

    launchCommandDeps.createLauncher = () => ({
      prepare: async (request) => {
        requests.push(request);
        throw new LaunchPreflightError("authentication failed");
      },
    });
    launchCommandDeps.createProgress = () => {
      throw new Error("progress must not render without two TTY streams");
    };
    launchCommandDeps.runIndexCapCommand = async () => {
      throw new Error("index must not run after a blocked launch");
    };

    try {
      await runLaunchToolCommand("claude", [], { skipConfirmation: true });
    } finally {
      launchCommandDeps.createLauncher = originalCreateLauncher;
      launchCommandDeps.createProgress = originalCreateProgress;
      launchCommandDeps.runIndexCapCommand = originalRunIndexCapCommand;
    }

    expect(requests[0]?.interactiveGit).toBe(false);
    expect(process.exitCode).toBe(1);
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

describe("ensureUnambiguousCompanion precedence", () => {
  const originalResolveLinkedCompanions = launchAmbiguityDeps.resolveLinkedCompanions;
  const originalResolveProjection = launchAmbiguityDeps.resolveProjection;
  const originalFindRepoLocalLinkedRepository = launchAmbiguityDeps.findRepoLocalLinkedRepository;
  const originalProjectWorkingRepository = launchAmbiguityDeps.projectWorkingRepository;

  const MATCHES = [
    { companionPath: "/tmp/companion-a", repositoryId: "from-a" },
    { companionPath: "/tmp/companion-b", repositoryId: "from-b" },
  ];

  const projecting = (companionPath: string) =>
    mock(() => ({
      repoRoot: "/tmp/repo",
      version: "0.0.0",
      companionPath,
      repositoryPath: "/tmp/repo",
      repositoryId: "app",
      wrapperBinPath: "/bin",
      reactDoctorBinPath: "/bin",
      graphifyOut: "/out",
    }));

  const neverPicks = mock(async () => {
    throw new Error("picker should not run");
  });

  beforeEach(() => {
    delete process.env.MATE_ARTIFACT_PATH;
    delete process.env.MATE_REPO_ID;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    launchAmbiguityDeps.resolveCompanionMatches = mock(async () => MATCHES);
    launchAmbiguityDeps.resolveProjection = mock(() => null);
    launchAmbiguityDeps.findRepoLocalLinkedRepository = mock(async () => ({
      id: "app",
      path: "/tmp/repo",
    }));
    launchAmbiguityDeps.projectWorkingRepository = mock(async () => ({
      kind: "written" as const,
      projectionRoot: "/tmp/repo/.mate",
      companionPath: "/tmp/companion-b",
    }));
  });

  afterEach(() => {
    launchAmbiguityDeps.resolveLinkedCompanions = originalResolveLinkedCompanions;
    launchAmbiguityDeps.resolveProjection = originalResolveProjection;
    launchAmbiguityDeps.findRepoLocalLinkedRepository = originalFindRepoLocalLinkedRepository;
    launchAmbiguityDeps.projectWorkingRepository = originalProjectWorkingRepository;
  });

  function captureStderr(): { chunks: string[]; restore: () => void } {
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    return { chunks, restore: () => void (process.stderr.write = originalWrite) };
  }

  test("a projected companion answers ambiguity without prompting", async () => {
    launchAmbiguityDeps.resolveProjection = projecting("/tmp/companion-b");
    launchAmbiguityDeps.selectCompanion = neverPicks;

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-b");
    expect(process.env.MATE_REPO_ID).toBe("from-b");
  });

  test("a projected companion answers ambiguity without a TTY", async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    launchAmbiguityDeps.resolveProjection = projecting("/tmp/companion-a");

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-a");
  });

  test("the launch environment outranks the projection", async () => {
    process.env.MATE_ARTIFACT_PATH = "/tmp/companion-a";
    process.env.MATE_REPO_ID = "from-a";
    launchAmbiguityDeps.resolveProjection = mock(() => {
      throw new Error("projection should not be read");
    });

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-a");
  });

  test("a projected companion that no longer links the repo falls through to the picker", async () => {
    launchAmbiguityDeps.resolveProjection = projecting("/tmp/companion-gone");
    launchAmbiguityDeps.selectCompanion = mock(async () => MATCHES[1]!);

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-b");
  });

  test("ignoreProjection asks again even when an answer is recorded", async () => {
    launchAmbiguityDeps.resolveProjection = projecting("/tmp/companion-a");
    launchAmbiguityDeps.selectCompanion = mock(async () => MATCHES[1]!);

    expect(await ensureUnambiguousCompanion("/tmp/repo", { ignoreProjection: true })).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-b");
  });

  test("reselect ignores the projection too", async () => {
    launchAmbiguityDeps.resolveProjection = projecting("/tmp/companion-a");
    launchAmbiguityDeps.selectCompanion = mock(async () => MATCHES[1]!);

    expect(await ensureUnambiguousCompanion("/tmp/repo", { reselect: true })).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-b");
  });

  test("the picker's answer is recorded at the Projection Root", async () => {
    launchAmbiguityDeps.selectCompanion = mock(async () => MATCHES[1]!);

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(launchAmbiguityDeps.projectWorkingRepository).toHaveBeenCalledWith("/tmp/companion-b", {
      id: "app",
      path: "/tmp/repo",
    });
  });

  test("an unlinked working repo records nothing", async () => {
    launchAmbiguityDeps.findRepoLocalLinkedRepository = mock(async () => null);
    launchAmbiguityDeps.selectCompanion = mock(async () => MATCHES[1]!);

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(launchAmbiguityDeps.projectWorkingRepository).not.toHaveBeenCalled();
  });

  test("a failed recording does not fail the command", async () => {
    launchAmbiguityDeps.projectWorkingRepository = mock(async () => ({
      kind: "failed" as const,
      error: new Error("read-only"),
    }));
    launchAmbiguityDeps.selectCompanion = mock(async () => MATCHES[1]!);

    expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(true);
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-b");
  });

  test("cancelling the picker records nothing and leaves the answer unset", async () => {
    launchAmbiguityDeps.resolveProjection = projecting("/tmp/companion-a");
    launchAmbiguityDeps.selectCompanion = mock(async () => null);
    const { restore } = captureStderr();

    try {
      expect(await ensureUnambiguousCompanion("/tmp/repo", { ignoreProjection: true })).toBe(false);
    } finally {
      restore();
    }

    expect(launchAmbiguityDeps.projectWorkingRepository).not.toHaveBeenCalled();
    expect(process.env.MATE_ARTIFACT_PATH).toBeUndefined();
  });

  test("an explicit companion outranks the launch environment", async () => {
    process.env.MATE_ARTIFACT_PATH = "/tmp/companion-a";
    process.env.MATE_REPO_ID = "from-a";
    launchAmbiguityDeps.resolveLinkedCompanions = mock(async () => MATCHES);
    launchAmbiguityDeps.selectCompanion = neverPicks;

    expect(await ensureUnambiguousCompanion("/tmp/repo", { companion: "/tmp/companion-b" })).toBe(
      true,
    );
    expect(process.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion-b");
    expect(process.env.MATE_REPO_ID).toBe("from-b");
  });

  test("an explicit companion that does not link the repo fails, listing the linked set", async () => {
    launchAmbiguityDeps.resolveLinkedCompanions = mock(async () => MATCHES);
    const { chunks, restore } = captureStderr();

    try {
      expect(
        await ensureUnambiguousCompanion("/tmp/repo", { companion: "/tmp/companion-gone" }),
      ).toBe(false);
    } finally {
      restore();
    }

    expect(chunks.join("")).toContain("does not link this working repo");
    expect(chunks.join("")).toContain("/tmp/companion-a");
    expect(chunks.join("")).toContain("/tmp/companion-b");
    expect(process.env.MATE_ARTIFACT_PATH).toBeUndefined();
  });

  test("the non-TTY guidance names wrap alongside the env override", async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    const { chunks, restore } = captureStderr();

    try {
      expect(await ensureUnambiguousCompanion("/tmp/repo")).toBe(false);
    } finally {
      restore();
    }

    expect(chunks.join("")).toContain("wrap --companion");
    expect(chunks.join("")).toContain("MATE_ARTIFACT_PATH");
  });
});
