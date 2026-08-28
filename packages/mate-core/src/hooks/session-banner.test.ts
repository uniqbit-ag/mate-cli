import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { mateInstallPath, mateVersion } from "../runtime/install";
import {
  computeProjectionStamp,
  projectionYamlPath,
  writeProjectionPair,
} from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { buildBanner, PROJECTED_BANNER_FLAG } from "./session-banner";

const tempRoots: string[] = [];
const REGISTRY_CONTENT = "companions: []\n";

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function currentStamp(): string {
  return computeProjectionStamp({
    version: mateVersion(),
    installPath: mateInstallPath(),
    registryContent: REGISTRY_CONTENT,
  });
}

function wrapRepo(repoRoot: string, companionPath: string, stamp: string): void {
  const registryPath = repoLocalRegistryPath(repoRoot);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, REGISTRY_CONTENT, "utf8");
  writeProjectionPair(repoRoot, {
    stamp,
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: path.join(companionPath, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });
}

function bannerMessage(outcome: { stdout: string }): string {
  return (JSON.parse(outcome.stdout) as { systemMessage: string }).systemMessage;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("session-banner hook module", () => {
  test("emits a systemMessage banner with repo and artifact paths", () => {
    const result = buildBanner({
      MATE_REPO_PATH: "/work/acme",
      MATE_ARTIFACT_PATH: "/companions/acme-companion",
      MATE_VERSION: "1.2.3",
    });

    expect(result.exitCode).toBe(0);
    const message = bannerMessage(result);
    expect(message).toContain("mate v1.2.3");
    expect(message).toContain("/work/acme");
    expect(message).toContain("/companions/acme-companion");
  });

  test("a managed session reports no staleness", () => {
    const repoRoot = makeTempDir("banner-managed-");
    wrapRepo(repoRoot, path.join(repoRoot, "projected"), "written-by-another-mate");

    const message = bannerMessage(
      buildBanner(
        { MATE_REPO_PATH: repoRoot, MATE_ARTIFACT_PATH: "/companions/launched" },
        repoRoot,
      ),
    );

    expect(message).toContain("/companions/launched");
    expect(message).not.toContain("mate wrap");
  });

  test("falls back to the running install's version", () => {
    const result = buildBanner({
      MATE_REPO_PATH: "/work/acme",
      MATE_ARTIFACT_PATH: "/companions/acme-companion",
    });
    expect(bannerMessage(result)).toContain(`mate v${mateVersion()}`);
  });

  test("resolves the projected paths when the environment is empty", () => {
    const repoRoot = makeTempDir("banner-wrapped-");
    const companion = path.join(repoRoot, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repoRoot, companion, currentStamp());

    const message = bannerMessage(buildBanner({}, repoRoot));

    expect(message).toContain(repoRoot);
    expect(message).toContain(companion);
    expect(message).not.toContain("mate wrap");
  });

  test("reports a stale stamp alongside the resolved paths", () => {
    const repoRoot = makeTempDir("banner-stale-");
    const companion = path.join(repoRoot, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repoRoot, companion, "written-by-another-mate");

    const message = bannerMessage(buildBanner({}, repoRoot));

    expect(message).toContain(companion);
    expect(message).toContain("mate wrap");
  });

  test("reports a missing companion", () => {
    const repoRoot = makeTempDir("banner-gone-");
    const companion = path.join(repoRoot, "removed");
    wrapRepo(repoRoot, companion, currentStamp());

    const message = bannerMessage(buildBanner({}, repoRoot));

    expect(message).toContain(companion);
    expect(message).toContain("mate wrap");
  });

  test("stays silent when no context resolves", () => {
    const bare = makeTempDir("banner-unwrapped-");

    expect(buildBanner({}, bare)).toEqual({ exitCode: 0, stdout: "" });
    expect(buildBanner({ MATE_REPO_PATH: "/work/acme" }, bare)).toEqual({
      exitCode: 0,
      stdout: "",
    });
    expect(buildBanner({ MATE_ARTIFACT_PATH: "/companions/x" }, bare)).toEqual({
      exitCode: 0,
      stdout: "",
    });
  });

  test("stays silent when the projection is unparseable", () => {
    const repoRoot = makeTempDir("banner-truncated-");
    wrapRepo(repoRoot, path.join(repoRoot, "companion"), currentStamp());
    const yamlPath = projectionYamlPath(repoRoot);
    fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, "utf8").slice(0, 45), "utf8");

    expect(buildBanner({}, repoRoot)).toEqual({ exitCode: 0, stdout: "" });
  });

  /**
   * A managed launch loads the bundled plugin *and* the Working Repository's
   * settings, and both register the same resolved command — so the copy the
   * wrap carried is flagged, and defers rather than doubling the banner.
   */
  describe(`the ${PROJECTED_BANNER_FLAG} copy a wrap carries`, () => {
    test("defers to the launch's own copy under a Mate environment", () => {
      const result = buildBanner(
        { MATE_REPO_PATH: "/work/acme", MATE_ARTIFACT_PATH: "/companions/acme-companion" },
        "/work/acme",
        [PROJECTED_BANNER_FLAG],
      );

      expect(result).toEqual({ exitCode: 0, stdout: "" });
    });

    test("prints in a session Mate did not launch", () => {
      const repoRoot = makeTempDir("banner-projected-");
      const companion = path.join(repoRoot, "companion");
      fs.mkdirSync(companion, { recursive: true });
      wrapRepo(repoRoot, companion, currentStamp());

      const message = bannerMessage(buildBanner({}, repoRoot, [PROJECTED_BANNER_FLAG]));

      expect(message).toContain(repoRoot);
      expect(message).toContain(companion);
    });

    /** The plugin's own copy is unflagged, so a launch never silences it. */
    test("leaves the unflagged copy printing under the same environment", () => {
      const result = buildBanner(
        { MATE_REPO_PATH: "/work/acme", MATE_ARTIFACT_PATH: "/companions/acme-companion" },
        "/work/acme",
      );

      expect(bannerMessage(result)).toContain("/work/acme");
    });
  });
});
