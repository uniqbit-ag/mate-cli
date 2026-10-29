import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { mateVersion } from "../runtime/install";
import {
  computeProjectionStamp,
  projectionYamlPath,
  writeProjectionPair,
} from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { PROJECTED_FLAG } from "../runtime/projected-flag";
import { trustProjection } from "../../test/trusted-projection";
import { buildBanner } from "./session-banner";

const tempRoots: string[] = [];
const REGISTRY_CONTENT = "companions: []\n";

/** Real paths, since Session Resolution names the Checkout by its real path. */
function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function currentStamp(): string {
  return computeProjectionStamp({
    version: mateVersion(),
    registryContent: REGISTRY_CONTENT,
  });
}

/** Projects `companionPath` into `repoRoot`; returns a plain-session environment that does not trust it. */
function wrapRepo(repoRoot: string, companionPath: string, stamp: string): { HOME: string } {
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
  return { HOME: path.join(repoRoot, "home") };
}

/** {@link wrapRepo}, with the companion registered and linking `repoRoot`, as `mate wrap` leaves it. */
function wrapTrustedRepo(repoRoot: string, companionPath: string, stamp: string): { HOME: string } {
  const { HOME } = wrapRepo(repoRoot, companionPath, stamp);
  return trustProjection({ home: HOME, companionPath, repoRoot, repositoryId: "acme" });
}

function bannerMessage(outcome: { stdout: string }): string {
  return (JSON.parse(outcome.stdout) as { systemMessage: string }).systemMessage;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("session-banner hook module", () => {
  test("emits a systemMessage banner with repo and artifact paths", async () => {
    const result = await buildBanner({
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

  test("a managed session reports no staleness", async () => {
    const repoRoot = makeTempDir("banner-managed-");
    wrapRepo(repoRoot, path.join(repoRoot, "projected"), "written-by-another-mate");

    const message = bannerMessage(
      await buildBanner(
        { MATE_REPO_PATH: repoRoot, MATE_ARTIFACT_PATH: "/companions/launched" },
        repoRoot,
      ),
    );

    expect(message).toContain("/companions/launched");
    expect(message).not.toContain("mate wrap");
  });

  test("falls back to the running install's version", async () => {
    const result = await buildBanner({
      MATE_REPO_PATH: "/work/acme",
      MATE_ARTIFACT_PATH: "/companions/acme-companion",
    });
    expect(bannerMessage(result)).toContain(`mate v${mateVersion()}`);
  });

  test("resolves the projected paths when the environment is empty", async () => {
    const repoRoot = makeTempDir("banner-wrapped-");
    const companion = path.join(repoRoot, "companion");
    fs.mkdirSync(companion, { recursive: true });
    const env = wrapTrustedRepo(repoRoot, companion, currentStamp());

    const message = bannerMessage(await buildBanner(env, repoRoot));

    expect(message).toContain(repoRoot);
    expect(message).toContain(companion);
    expect(message).not.toContain("mate wrap");
  });

  test("reports a stale stamp alongside the resolved paths", async () => {
    const repoRoot = makeTempDir("banner-stale-");
    const companion = path.join(repoRoot, "companion");
    fs.mkdirSync(companion, { recursive: true });
    const env = wrapTrustedRepo(repoRoot, companion, "written-by-another-mate");

    const message = bannerMessage(await buildBanner(env, repoRoot));

    expect(message).toContain(companion);
    expect(message).toContain("mate wrap");
  });

  describe("a projection Session Resolution refuses", () => {
    function expectRefusalNotice(outcome: { exitCode: number; stdout: string }, code: string) {
      expect(outcome.exitCode).toBe(0);
      const output = JSON.parse(outcome.stdout) as Record<string, unknown>;
      expect(Object.keys(output)).toEqual(["systemMessage"]);
      expect(output.systemMessage).toContain(code);
      expect(output.systemMessage).toContain("mate doctor");
    }

    test("reports an unregistered companion to the operator alone", async () => {
      const repoRoot = makeTempDir("banner-unregistered-");
      const companion = path.join(repoRoot, "companion");
      fs.mkdirSync(companion, { recursive: true });
      const env = wrapRepo(repoRoot, companion, currentStamp());

      expectRefusalNotice(await buildBanner(env, repoRoot), "companion-not-registered");
    });

    test("reports a companion that does not link the Checkout", async () => {
      const repoRoot = makeTempDir("banner-unlinked-");
      const companion = path.join(repoRoot, "companion");
      fs.mkdirSync(companion, { recursive: true });
      const env = wrapTrustedRepo(repoRoot, companion, currentStamp());
      fs.rmSync(path.join(companion, ".mate"), { recursive: true, force: true });

      expectRefusalNotice(await buildBanner(env, repoRoot), "repository-not-linked");
    });

    test("reports a missing companion", async () => {
      const repoRoot = makeTempDir("banner-gone-");
      const env = wrapRepo(repoRoot, path.join(repoRoot, "removed"), currentStamp());

      expectRefusalNotice(await buildBanner(env, repoRoot), "companion-missing");
    });

    /** The `--projected` copy defers only to a launch; a refusal has none, so it prints once. */
    test("the copy a wrap carries prints the notice too", async () => {
      const repoRoot = makeTempDir("banner-refused-projected-");
      const companion = path.join(repoRoot, "companion");
      fs.mkdirSync(companion, { recursive: true });
      const env = wrapRepo(repoRoot, companion, currentStamp());

      expectRefusalNotice(
        await buildBanner(env, repoRoot, [PROJECTED_FLAG]),
        "companion-not-registered",
      );
    });
  });

  test("stays silent when no context resolves", async () => {
    const bare = makeTempDir("banner-unwrapped-");

    expect(await buildBanner({}, bare)).toEqual({ exitCode: 0, stdout: "" });
    expect(await buildBanner({ MATE_REPO_PATH: "/work/acme" }, bare)).toEqual({
      exitCode: 0,
      stdout: "",
    });
    expect(await buildBanner({ MATE_ARTIFACT_PATH: "/companions/x" }, bare)).toEqual({
      exitCode: 0,
      stdout: "",
    });
  });

  test("stays silent when the projection is unparseable", async () => {
    const repoRoot = makeTempDir("banner-truncated-");
    const companion = path.join(repoRoot, "companion");
    fs.mkdirSync(companion, { recursive: true });
    const env = wrapTrustedRepo(repoRoot, companion, currentStamp());
    const yamlPath = projectionYamlPath(repoRoot);
    fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, "utf8").slice(0, 45), "utf8");

    expect(await buildBanner(env, repoRoot)).toEqual({ exitCode: 0, stdout: "" });
  });

  /**
   * A managed launch loads the bundled plugin *and* the Working Repository's
   * settings, and both register the same resolved command — so the copy the
   * wrap carried is flagged, and defers rather than doubling the banner.
   */
  describe(`the ${PROJECTED_FLAG} copy a wrap carries`, () => {
    test("defers to the launch's own copy under a Mate environment", async () => {
      const result = await buildBanner(
        { MATE_REPO_PATH: "/work/acme", MATE_ARTIFACT_PATH: "/companions/acme-companion" },
        "/work/acme",
        [PROJECTED_FLAG],
      );

      expect(result).toEqual({ exitCode: 0, stdout: "" });
    });

    test("prints in a session Mate did not launch", async () => {
      const repoRoot = makeTempDir("banner-projected-");
      const companion = path.join(repoRoot, "companion");
      fs.mkdirSync(companion, { recursive: true });
      const env = wrapTrustedRepo(repoRoot, companion, currentStamp());

      const message = bannerMessage(await buildBanner(env, repoRoot, [PROJECTED_FLAG]));

      expect(message).toContain(repoRoot);
      expect(message).toContain(companion);
    });

    /** The plugin's own copy is unflagged, so a launch never silences it. */
    test("leaves the unflagged copy printing under the same environment", async () => {
      const result = await buildBanner(
        { MATE_REPO_PATH: "/work/acme", MATE_ARTIFACT_PATH: "/companions/acme-companion" },
        "/work/acme",
      );

      expect(bannerMessage(result)).toContain("/work/acme");
    });
  });
});
