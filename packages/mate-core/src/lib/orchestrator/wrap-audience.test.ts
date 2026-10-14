import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { withEnv } from "../../../test/helpers";
import { readManifest } from "../../runtime/runtime-document-manifest";
import { readWrapState } from "../../runtime/wrap-state";
import {
  installFixturePackage,
  makeAudienceFixture,
  markerHitsInTree,
  markerHitsInValue,
  type AudienceFixture,
} from "../../tools/setup/audience-isolation.fixture";
import { runtimeDocumentDeps } from "./projection-runtime-documents";
import { writeRepoLocalRegistryEntry } from "./repository-link";
import type { LinkedRepository } from "./types";
import { unwrapWorkingRuntimeDocuments } from "./working-repo-projection";
import { runWrapPass } from "./wrap-pass";
import { prepareSession, sessionPrepareDeps } from "./session-prepare";
import { currentAudienceLayer, audienceLayerDir } from "../../runtime/audience-layer";

let fixture: AudienceFixture;
let repository: LinkedRepository;
let home: string;
const originalHomeDir = runtimeDocumentDeps.homeDir;

/** The companion link leads back into the companion and its installed plugin sources. */
const SKIP = [path.join(".mate", "companion"), ".git"];

beforeEach(async () => {
  fixture = await makeAudienceFixture();
  home = path.join(fixture.root, "home");
  await fs.mkdir(home, { recursive: true });
  runtimeDocumentDeps.homeDir = () => home;
  execFileSync("git", ["init", "-q"], { cwd: fixture.repoPath });
  repository = { id: "app", path: fixture.repoPath };
  await writeRepoLocalRegistryEntry(fixture.repoPath, fixture.companionPath, repository, "git");
  for (const owner of ["ba", "qa"] as const) await installFixturePackage(fixture, owner);
});

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
  await fixture.cleanup();
});

const wrap = (audience?: string | null) =>
  runWrapPass(fixture.companionPath, repository, {
    config: fixture.config,
    ...(audience === undefined ? {} : { audience }),
  });

async function claudeJson(): Promise<string> {
  return fs.readFile(path.join(home, ".claude.json"), "utf8").catch(() => "");
}

async function hits(owners: Array<"ba" | "qa">): Promise<string[]> {
  return [
    ...(await markerHitsInTree(fixture.repoPath, owners, SKIP)),
    ...markerHitsInValue("~/.claude.json", await claudeJson(), owners),
  ];
}

describe("a checkout wrapped for an audience", () => {
  test("records the audience and carries base plus its contributions", async () => {
    const result = await wrap("ba");

    expect(result.kind).not.toBe("failed");
    expect((await readWrapState(fixture.repoPath)).audience).toBe("ba");
    const baHits = await hits(["ba"]);
    for (const expected of [
      `${path.join(".claude", "settings.local.json")}: ba`,
      `${path.join(".opencode", "opencode.json")}: ba`,
      `${path.join(".claude", "skills", "ba-skill", "SKILL.md")}: ba`,
      `${path.join(".claude", "agents", "ba-agent.md")}: ba`,
      "~/.claude.json: ba",
    ]) {
      expect(baHits).toContain(expected);
    }
    expect(await hits(["qa"])).toEqual([]);
    const agent = path.join(fixture.repoPath, ".claude", "agents", "ba-agent.md");
    expect((await fs.lstat(agent)).isSymbolicLink()).toBe(true);
  });

  test("an undeclared audience, or base, is refused and the wrap is unchanged", async () => {
    for (const audience of ["ops", "base"]) {
      const result = await wrap(audience);
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") continue;
      expect(result.message).toContain(`"${audience}"`);
      expect(result.message).toContain("ba, qa");
    }
    expect((await readManifest(fixture.repoPath)).audience).toBeUndefined();
    expect(await hits(["ba", "qa"])).toEqual([]);
  });

  test("a pass that names no audience keeps the recorded one, whatever MATE_AUDIENCE says", async () => {
    await wrap("ba");
    await withEnv("MATE_AUDIENCE", "qa", () => wrap());

    expect((await readWrapState(fixture.repoPath)).audience).toBe("ba");
    expect(await hits(["ba"])).not.toEqual([]);
    expect(await hits(["qa"])).toEqual([]);
  });

  test("switching audiences leaves nothing of the previous one", async () => {
    await wrap("ba");
    await wrap("qa");

    expect((await readWrapState(fixture.repoPath)).audience).toBe("qa");
    expect(await hits(["ba"])).toEqual([]);
    expect(await hits(["qa"])).not.toEqual([]);
  });

  test("re-wrapping without an audience returns the checkout to base", async () => {
    await wrap("ba");
    await wrap(null);

    expect((await readWrapState(fixture.repoPath)).audience).toBeNull();
    expect(await hits(["ba", "qa"])).toEqual([]);
  });

  test("another checkout of the companion stays base", async () => {
    const otherPath = path.join(fixture.root, "other");
    await fs.mkdir(otherPath, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: otherPath });
    const other: LinkedRepository = { id: "other", path: otherPath };
    await writeRepoLocalRegistryEntry(otherPath, fixture.companionPath, other, "git");

    await wrap("ba");
    await runWrapPass(fixture.companionPath, other, { config: fixture.config, audience: null });

    expect((await readWrapState(otherPath)).audience).toBeNull();
    expect(await markerHitsInTree(otherPath, ["ba", "qa"], SKIP)).toEqual([]);
    const otherKey = JSON.parse(await claudeJson()).projects?.[otherPath] ?? {};
    expect(markerHitsInValue("other ~/.claude.json", otherKey, ["ba", "qa"])).toEqual([]);
  });

  test("unwrapping withdraws the audience with the rest of the wrap", async () => {
    await wrap("ba");
    await unwrapWorkingRuntimeDocuments(fixture.repoPath);

    expect((await readManifest(fixture.repoPath)).audience).toBeUndefined();
    expect(await hits(["ba", "qa"])).toEqual([]);
  });
});

describe("a bare session's prepare in a checkout wrapped for an audience", () => {
  const original = { ...sessionPrepareDeps };
  afterEach(() => {
    Object.assign(sessionPrepareDeps, original);
  });

  async function barePrepare(mode: "local" | "sync") {
    sessionPrepareDeps.syncCompanionFiles = async () => {};
    sessionPrepareDeps.runCapabilityPreflight = async () => {};
    sessionPrepareDeps.syncCompanionUnattended = async () =>
      ({ status: "complete", changed: true, companionPath: fixture.companionPath }) as never;
    sessionPrepareDeps.readCompanionConfig = async () => fixture.config;
    sessionPrepareDeps.withCompanionLock = (async (
      _companion: string,
      _options: unknown,
      task: () => Promise<unknown>,
    ) => ({ acquired: true, value: await task() })) as never;
    return withEnv("MATE_AUDIENCE", "qa", () =>
      prepareSession({
        runtime: "claude",
        runtimes: ["claude", "opencode"],
        companionPath: fixture.companionPath,
        repository,
        mode,
        config: fixture.config,
      }),
    );
  }

  for (const mode of ["local", "sync"] as const) {
    test(`a ${mode} prepare keeps the recorded audience, ignores MATE_AUDIENCE and refreshes the layer`, async () => {
      await wrap("ba");
      await fs.rm(audienceLayerDir(fixture.companionPath, "ba"), { recursive: true, force: true });

      const result = await barePrepare(mode);

      expect(result.ok).toBe(true);
      expect(result.audienceLayer).toBeUndefined();
      expect((await readWrapState(fixture.repoPath)).audience).toBe("ba");
      expect(currentAudienceLayer(fixture.companionPath, "ba")).not.toBeNull();
      expect(currentAudienceLayer(fixture.companionPath, "qa")).toBeNull();
      expect(await hits(["ba"])).not.toEqual([]);
      expect(await hits(["qa"])).toEqual([]);
    });
  }
});
