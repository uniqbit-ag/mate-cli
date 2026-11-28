import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import type { TakeResult } from "../../../../lib/delivery/staging/submit";
import { runArtifactTakeCommand, type TakeCommandDeps } from "./take";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

function deps(result: TakeResult, calls: unknown[][] = []): TakeCommandDeps {
  return {
    ensureUnambiguousCompanion: async () => true,
    resolveContext: async () =>
      ({
        companionPath: "/acme-companion",
        repositoryId: "acme",
        configStore: { load: async () => ({}) },
        workingRepoStore: {},
      }) as unknown as LaunchContext,
    loadCapabilities: async () => [{ name: "openspec" }],
    take: async (...args) => {
      calls.push(args);
      return result;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
}

const taken: TakeResult = {
  change: "acme-alpha",
  status: "taken",
  path: "openspec/changes/acme-alpha",
  message: "Took acme-alpha.",
};

describe("mate artifact take", () => {
  test("takes the named change from the companion and prints the result", async () => {
    const calls: unknown[][] = [];

    await runArtifactTakeCommand(["acme-alpha", "--json"], deps(taken, calls));

    expect(calls).toEqual([["/acme-companion", "acme-alpha"]]);
    expect(JSON.parse(out[0]!)).toEqual(taken);
    expect(process.exitCode).toBe(0);
  });

  const refused: TakeResult = {
    ...taken,
    status: "refused",
    path: null,
    reason: "exists",
    message: "mate: held.",
  };

  test("exits non-zero when the change was refused, naming the reason on stderr", async () => {
    await runArtifactTakeCommand(["acme-alpha"], deps(refused));

    expect(out).toEqual([]);
    expect(err).toEqual(["mate: held."]);
    expect(process.exitCode).toBe(1);
  });

  test("with --json a refusal keeps stdout to the JSON document", async () => {
    await runArtifactTakeCommand(["acme-alpha", "--json"], deps(refused));

    expect(out).toEqual([JSON.stringify(refused)]);
    expect(err).toEqual(["mate: held."]);
    expect(process.exitCode).toBe(1);
  });

  test("requires exactly one change name", async () => {
    const calls: unknown[][] = [];

    await runArtifactTakeCommand(["acme-alpha", "acme-beta"], deps(taken, calls));

    expect(calls).toEqual([]);
    expect(err).toEqual(["mate: artifact take requires one submitted change name."]);
    expect(process.exitCode).toBe(1);
  });
});
