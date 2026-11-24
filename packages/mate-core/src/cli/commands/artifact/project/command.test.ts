import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ProjectDeps, ProjectionResult } from "../../../../lib/delivery/staging/project";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import { runArtifactProjectCommand, type ProjectCommandDeps } from "./command";

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

function deps(
  result: ProjectionResult,
  calls: ProjectDeps[] = [],
  auto = false,
): ProjectCommandDeps {
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
    loadGitAutoMode: async () => auto,
    project: async (_companion, _change, projectDeps) => {
      calls.push(projectDeps);
      return result;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
}

const projected: ProjectionResult = {
  status: "ok",
  change: "acme-login-ui",
  chain: [{ name: "acme-login-api", source: "submitted" }],
  dir: "/tmp/mate-projection-acme",
  files: [
    {
      path: "openspec/specs/widget/spec.md",
      file: "/tmp/mate-projection-acme/openspec/specs/widget/spec.md",
      content: "### Requirement: Login\n",
    },
  ],
  message: "Projected 1 file once acme-login-api is published, in /tmp/mate-projection-acme.",
};

describe("mate artifact project", () => {
  test("reports the projected specs, fetching first in Git mode auto", async () => {
    const calls: ProjectDeps[] = [];

    await runArtifactProjectCommand(["acme-login-ui"], deps(projected, calls, true));

    expect(calls).toEqual([{ fetch: true }]);
    expect(out).toEqual([
      projected.message,
      "  applied: acme-login-api (submitted)",
      "  openspec/specs/widget/spec.md  /tmp/mate-projection-acme/openspec/specs/widget/spec.md",
    ]);
  });

  test("emits JSON and exits non-zero when the chain would not publish", async () => {
    const conflict: ProjectionResult = {
      ...projected,
      status: "conflict",
      dir: null,
      files: [],
      message: "mate: refused.",
    };

    await runArtifactProjectCommand(["acme-login-ui", "--json"], deps(conflict));

    expect(JSON.parse(out[0]!)).toEqual(conflict);
    expect(process.exitCode).toBe(1);
  });

  test("requires one change name", async () => {
    await runArtifactProjectCommand([], deps(projected));

    expect(err).toEqual(["mate: artifact project requires one change name."]);
    expect(process.exitCode).toBe(1);
  });
});
