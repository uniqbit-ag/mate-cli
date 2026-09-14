import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runArtifactPublishCommand } from "./command";
import type { PublishCommandDeps } from "./command";
import { defaultGitOps } from "./git";
import { openspecSpecsFinisher, resolveDriftedSpecs } from "./openspec";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";

/**
 * End-to-end cover for the spec publication unit against real git: the unit tests stub
 * GitOps, so only this file proves the tag namespace, commit subject, and commit scope
 * that land in an actual repository.
 */

const tempRoots: string[] = [];

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function write(root: string, relative: string, body: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, "utf8");
}

/** A companion with one committed canonical spec and one committed archive. */
async function companion(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-spec-publication-"));
  tempRoots.push(root);
  git(root, ["init", "--initial-branch", "main"]);
  git(root, ["config", "user.name", "Mate"]);
  git(root, ["config", "user.email", "mate@example.test"]);
  git(root, ["config", "core.excludesFile", "/dev/null"]);
  await write(root, "openspec/specs/widget-api/spec.md", "# widget-api\n");
  await write(root, "openspec/specs/other-api/spec.md", "# other-api\n");
  await write(root, "openspec/changes/archive/2026-09-07-acme/proposal.md", "archived\n");
  await write(root, "unrelated.md", "untouched\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "seed"]);
  return root;
}

function deps(root: string, stdout: string[]): PublishCommandDeps {
  return {
    ensureUnambiguousCompanion: async () => true,
    resolveContext: async () =>
      ({
        companionPath: root,
        repositoryId: "repo",
        configStore: {} as LaunchContext["configStore"],
        workingRepoStore: {} as LaunchContext["workingRepoStore"],
      }) as LaunchContext,
    loadCapabilities: async () => [{ name: "openspec" }],
    /** The real finisher, minus the cap sync that would shell out to the CLI. */
    specsFinisher: (context, paths, now) => {
      const finisher = openspecSpecsFinisher(context, paths, now);
      return { ...finisher, capSync: undefined };
    },
    git: () => defaultGitOps(root),
    now: () => new Date(2026, 8, 14),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stdout.push(line),
  };
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("spec publication against real git", () => {
  test("commits the drifted specs under a dated spec tag and nothing else", async () => {
    const root = await companion();
    await write(root, "openspec/specs/widget-api/spec.md", "# widget-api\n\nedited\n");
    await write(root, "unrelated.md", "also edited\n");
    const out: string[] = [];

    await runArtifactPublishCommand(["--specs", "--no-push", "--json"], deps(root, out));

    const result = JSON.parse(out[0]) as { status: string; tag: string; anchorName: string };
    expect(result.status).toBe("skipped");
    expect(result.tag).toBe("openspec/specs/2026-09-14-widget-api");
    expect(result.anchorName).toBe("2026-09-14-widget-api");

    /** The commit subject names the specs, never an anchor: it belongs to no change. */
    expect(gitOutput(root, ["log", "-1", "--pretty=%s"])).toBe(
      "chore(openspec): sync canonical specs (widget-api)",
    );
    /** Scope is exactly the drifted spec — the unrelated edit stays uncommitted. */
    expect(gitOutput(root, ["show", "--name-only", "--pretty=", "HEAD"]).split("\n")).toEqual([
      "openspec/specs/widget-api/spec.md",
    ]);
    expect(gitOutput(root, ["status", "--porcelain"])).toContain("unrelated.md");
    /** The tag is annotated and sits in its own namespace. */
    expect(gitOutput(root, ["tag", "--list", "openspec/specs/*"])).toBe(
      "openspec/specs/2026-09-14-widget-api",
    );
    expect(gitOutput(root, ["tag", "--list", "openspec/2*"])).toBe("");
    expect(gitOutput(root, ["cat-file", "-t", "openspec/specs/2026-09-14-widget-api"])).toBe("tag");
  });

  test("a second publication of the same specs the same day takes the next free suffix", async () => {
    const root = await companion();
    await write(root, "openspec/specs/widget-api/spec.md", "# widget-api\n\nfirst\n");
    await runArtifactPublishCommand(["--specs", "--no-push", "--json"], deps(root, []));

    await write(root, "openspec/specs/widget-api/spec.md", "# widget-api\n\nsecond\n");
    const out: string[] = [];
    await runArtifactPublishCommand(["--specs", "--no-push", "--json"], deps(root, out));

    const result = JSON.parse(out[0]) as { tag: string };
    expect(result.tag).toBe("openspec/specs/2026-09-14-widget-api.2");
    /** The first tag still points at the first publication, not the second. */
    expect(
      gitOutput(root, ["rev-list", "-n", "1", "openspec/specs/2026-09-14-widget-api"]),
    ).not.toBe(gitOutput(root, ["rev-list", "-n", "1", "openspec/specs/2026-09-14-widget-api.2"]));
    expect(gitOutput(root, ["show", "--name-only", "--pretty=", "HEAD"]).split("\n")).toEqual([
      "openspec/specs/widget-api/spec.md",
    ]);
  });

  test("a publication of several specs names each of them in its anchor", async () => {
    const root = await companion();
    await write(root, "openspec/specs/widget-api/spec.md", "# widget-api\n\nedited\n");
    await write(root, "openspec/specs/other-api/spec.md", "# other-api\n\nedited\n");
    const out: string[] = [];

    await runArtifactPublishCommand(["--specs", "--no-push", "--json"], deps(root, out));

    const result = JSON.parse(out[0]) as { tag: string };
    expect(result.tag).toBe("openspec/specs/2026-09-14-other-api+widget-api");
    expect(gitOutput(root, ["log", "-1", "--pretty=%s"])).toBe(
      "chore(openspec): sync canonical specs (other-api, widget-api)",
    );
  });

  test("a clean companion publishes nothing and succeeds", async () => {
    const root = await companion();
    const before = gitOutput(root, ["rev-parse", "HEAD"]);
    const out: string[] = [];

    await runArtifactPublishCommand(["--specs", "--no-push", "--json"], deps(root, out));

    const result = JSON.parse(out[0]) as { status: string; tag: string | null };
    expect(result.status).toBe("skipped");
    expect(result.tag).toBeNull();
    expect(process.exitCode).toBe(0);
    expect(gitOutput(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(gitOutput(root, ["tag", "--list"])).toBe("");
  });

  test("a spec owned by a pending change is left for that change to publish", async () => {
    const root = await companion();
    await write(root, "openspec/changes/archive/2026-09-14-widget/specs/widget-api/spec.md", "d\n");
    await write(root, "openspec/specs/widget-api/spec.md", "# widget-api\n\nedited\n");

    const drift = await resolveDriftedSpecs(root, defaultGitOps(root));

    expect(drift).toEqual({ ok: true, paths: [] });
  });

  test("publishing off the default branch is refused before any mutation", async () => {
    const root = await companion();
    await write(root, "openspec/specs/widget-api/spec.md", "# widget-api\n\nedited\n");
    git(root, ["checkout", "-b", "side"]);
    const before = gitOutput(root, ["rev-parse", "HEAD"]);
    const out: string[] = [];

    await runArtifactPublishCommand(["--specs", "--no-push", "--json"], deps(root, out));

    const result = JSON.parse(out[0]) as { status: string; step: string };
    expect(result.status).toBe("error");
    expect(result.step).toBe("branch-guard");
    expect(gitOutput(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(gitOutput(root, ["tag", "--list"])).toBe("");
  });
});
