import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { projectionFreshness, projectionStalenessLines } from "./freshness";
import { mateInstallPath, mateVersion } from "./install";
import { computeProjectionStamp, resolveProjection, writeProjectionPair } from "./projection";
import { repoLocalRegistryPath } from "./repo-local";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const REGISTRY_CONTENT = "companions: []\n";

function writeRepoLocalRegistry(repoRoot: string): void {
  const registryPath = repoLocalRegistryPath(repoRoot);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, REGISTRY_CONTENT, "utf8");
}

function currentStamp(): string {
  return computeProjectionStamp({
    version: mateVersion(),
    registryContent: REGISTRY_CONTENT,
  });
}

function wrap(repoRoot: string, companionPath: string, stamp: string): void {
  writeRepoLocalRegistry(repoRoot);
  writeProjectionPair(repoRoot, {
    stamp,
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: "/install/acme/wrappers/bin",
      reactDoctorBinPath: "/install/acme/node_modules/.bin/react-doctor",
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("mate install identity", () => {
  test("the install path is the package root and the version matches its manifest", () => {
    const manifest = path.join(mateInstallPath(), "package.json");

    expect(fs.existsSync(manifest)).toBe(true);
    expect(mateVersion()).toBe(JSON.parse(fs.readFileSync(manifest, "utf8")).version);
  });
});

describe("projectionFreshness", () => {
  test("a matching stamp and an existing companion is current", () => {
    const repoRoot = makeTempDir("fresh-current-");
    const companionPath = makeTempDir("fresh-companion-");
    wrap(repoRoot, companionPath, currentStamp());

    const verdict = projectionFreshness(resolveProjection(repoRoot)!);

    expect(verdict).toEqual({ stampCurrent: true, companionExists: true, isCurrent: true });
    expect(projectionStalenessLines(resolveProjection(repoRoot)!, verdict)).toEqual([]);
  });

  test("a stamp written by a different install is not current", () => {
    const repoRoot = makeTempDir("fresh-stale-");
    const companionPath = makeTempDir("fresh-companion-");
    wrap(repoRoot, companionPath, "written-by-another-mate");

    const verdict = projectionFreshness(resolveProjection(repoRoot)!);

    expect(verdict).toEqual({ stampCurrent: false, companionExists: true, isCurrent: false });
  });

  test("a missing companion is reported separately from a current stamp", () => {
    const repoRoot = makeTempDir("fresh-gone-");
    const companionPath = path.join(makeTempDir("fresh-parent-"), "removed");
    wrap(repoRoot, companionPath, currentStamp());

    expect(projectionFreshness(resolveProjection(repoRoot)!)).toEqual({
      stampCurrent: true,
      companionExists: false,
      isCurrent: false,
    });
  });

  test("a changed repo-local registry makes the stamp stale", () => {
    const repoRoot = makeTempDir("fresh-registry-changed-");
    const companionPath = makeTempDir("fresh-companion-");
    wrap(repoRoot, companionPath, currentStamp());
    fs.writeFileSync(repoLocalRegistryPath(repoRoot), "companions: [acme]\n", "utf8");

    expect(projectionFreshness(resolveProjection(repoRoot)!).stampCurrent).toBe(false);
  });
});

describe("projectionStalenessLines", () => {
  test("a stale stamp is reported naming mate wrap", () => {
    const repoRoot = makeTempDir("lines-stale-");
    const companionPath = makeTempDir("lines-companion-");
    wrap(repoRoot, companionPath, "written-by-another-mate");
    const projection = resolveProjection(repoRoot)!;

    const lines = projectionStalenessLines(projection, projectionFreshness(projection));

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("mate wrap");
  });

  test("a missing companion is reported naming both the path and mate wrap", () => {
    const repoRoot = makeTempDir("lines-gone-");
    const companionPath = path.join(makeTempDir("lines-parent-"), "removed");
    wrap(repoRoot, companionPath, currentStamp());
    const projection = resolveProjection(repoRoot)!;

    const lines = projectionStalenessLines(projection, projectionFreshness(projection));

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(companionPath);
    expect(lines[0]).toContain("mate wrap");
  });

  test("both axes are reported when both are off", () => {
    const repoRoot = makeTempDir("lines-both-");
    const companionPath = path.join(makeTempDir("lines-parent-"), "removed");
    wrap(repoRoot, companionPath, "written-by-another-mate");
    const projection = resolveProjection(repoRoot)!;

    expect(projectionStalenessLines(projection, projectionFreshness(projection)).length).toBe(2);
  });
});
