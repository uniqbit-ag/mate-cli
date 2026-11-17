import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { git } from "../../../../../test/git-checkouts";
import {
  archiveLocally,
  canonicalSpec,
  makeStagingFixture,
  proposeLocally,
  REAL_OPENSPEC,
  requirement,
  showAt,
  type StagingFixture,
} from "../../../../../test/staging-fixture";
import { publishSubmitted } from "../../../../lib/delivery/staging/publish";
import { submitGroups } from "../../../../lib/delivery/staging/submit";
import type { LaunchContext } from "../../../../lib/orchestrator/framework-context";
import { runArtifactPublishCommand, type PublishCommandDeps } from "./command";
import type { FinishResult } from "./engine";

/** Each case runs the real OpenSpec CLI and Git several times. */
const TIMEOUT = 120_000;
const fixtures: StagingFixture[] = [];

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function setup(): Promise<StagingFixture> {
  const fixture = await makeStagingFixture({ widget: canonicalSpec("widget", "Widget renders") });
  fixtures.push(fixture);
  return fixture;
}

function deps(fixture: StagingFixture, companion: string, out: string[]): PublishCommandDeps {
  return {
    ensureUnambiguousCompanion: async () => true,
    resolveContext: async () =>
      ({
        companionPath: companion,
        repositoryId: "acme",
        configStore: {} as LaunchContext["configStore"],
        workingRepoStore: {} as LaunchContext["workingRepoStore"],
      }) as LaunchContext,
    loadCapabilities: async () => [{ name: "openspec" }],
    worktreeCleanup: { readWorksets: async () => ({ worksets: [], errors: [] }) },
    publishSubmitted: (companionPath, target, publishDeps) =>
      publishSubmitted(companionPath, target, {
        ...publishDeps,
        runOpenSpec: fixture.runOpenSpec,
        tmpRoot: fixture.root,
      }),
    stdout: (line) => out.push(line),
    stderr: () => {},
  };
}

async function submit(
  fixture: StagingFixture,
  companion: string,
  name: string,
  options: Parameters<typeof proposeLocally>[3],
): Promise<void> {
  proposeLocally(fixture, companion, name, { ...options, state: "submitted" });
  await submitGroups(companion, [name], {
    tmpRoot: fixture.root,
    stateHome: path.join(fixture.root, "home"),
  });
}

const mainHead = (fixture: StagingFixture): string =>
  git(fixture.remote, "rev-parse", "main").trim();

describe.skipIf(!REAL_OPENSPEC)("mate artifact publish against a companion remote", () => {
  test(
    "an earlier Mate's local archive publishes from the checkout with a trailer and no tag",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const anchor = archiveLocally(fixture, companion, "acme-legacy", {
        deltas: { widget: requirement("ADDED", "Widget is legacy", "The widget SHALL be old.") },
      });
      const out: string[] = [];

      await runArtifactPublishCommand([anchor, "--json"], deps(fixture, companion, out));

      const result = JSON.parse(out[0]!) as FinishResult;
      expect(result).toMatchObject({ status: "ok", tag: null, anchorName: anchor });
      expect(result.commit).toBe(mainHead(fixture));
      expect(git(companion, "rev-parse", "HEAD").trim()).toBe(result.commit!);
      expect(
        git(
          fixture.remote,
          "log",
          "-1",
          "--format=%(trailers:key=Mate-Artifact,valueonly)",
          "main",
        ).trim(),
      ).toBe(`openspec/${anchor}`);
      expect(git(fixture.remote, "tag", "--list").trim()).toBe("");
    },
    TIMEOUT,
  );

  test(
    "pushes a publication an older version committed and tagged locally, once",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const anchor = archiveLocally(fixture, companion, "acme-legacy", {
        deltas: { widget: requirement("ADDED", "Widget is legacy", "The widget SHALL be old.") },
      });
      git(companion, "add", "-A");
      git(companion, "commit", "-qm", `chore(openspec): finish ${anchor}`);
      git(companion, "tag", "-a", `openspec/${anchor}`, "-m", `Publish ${anchor}`);
      const out: string[] = [];

      await runArtifactPublishCommand(["acme-legacy", "--json"], deps(fixture, companion, out));

      expect(JSON.parse(out[0]!)).toMatchObject({ status: "ok", resumed: true, tag: null });
      expect(mainHead(fixture)).toBe(git(companion, "rev-parse", "HEAD").trim());
      expect(git(fixture.remote, "tag", "--list").trim()).toBe(`openspec/${anchor}`);
    },
    TIMEOUT,
  );

  test(
    "--all publishes a publishable group after a conflicting one and exits non-zero",
    async () => {
      const fixture = await setup();
      const seed = mainHead(fixture);
      const beta = fixture.clone("acme-beta");
      await submit(fixture, beta, "acme-beta", {
        branch: "workset/acme-beta",
        merged: true,
        deltas: {
          widget: `## MODIFIED Requirements\n\n### Requirement: Widget renders\nThe widget SHALL hum.\n**Area:** \`packages/web\`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n`,
        },
      });
      const out: string[] = [];
      await runArtifactPublishCommand(["acme-beta", "--json"], deps(fixture, beta, out));
      expect((JSON.parse(out[0]!) as FinishResult).status).toBe("ok");

      const alpha = fixture.clone("acme-alpha");
      await submit(fixture, alpha, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: seed,
        deltas: {
          widget: `## MODIFIED Requirements\n\n### Requirement: Widget renders\nThe widget SHALL glow.\n**Area:** \`packages/web\`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n`,
        },
      });
      await submit(fixture, alpha, "acme-gamma", {
        branch: "workset/acme-gamma",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget shines", "The widget SHALL shine.") },
      });
      const all: string[] = [];

      await runArtifactPublishCommand(["--all", "--json"], deps(fixture, alpha, all));

      const results = JSON.parse(all[0]!) as FinishResult[];
      expect(results.map((result) => [result.group, result.status])).toEqual([
        ["acme_product/workset/acme-alpha", "conflict"],
        ["acme_product/workset/acme-gamma", "ok"],
      ]);
      expect(results[0]).toMatchObject({
        blocked: true,
        conflict: { requirement: "Widget renders" },
      });
      expect(showAt(fixture.remote, "main", "openspec/specs/widget/spec.md")).toContain(
        "Widget shines",
      );
      expect(process.exitCode).toBe(1);
    },
    TIMEOUT,
  );
});
