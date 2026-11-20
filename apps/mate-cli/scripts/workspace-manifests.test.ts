import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

type Manifest = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const readManifest = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, dir, "package.json"), "utf8")) as Manifest;
const workspaceDirs = [
  ".",
  ...["apps", "packages"].flatMap((group) =>
    fs
      .readdirSync(path.join(repoRoot, group))
      .map((name) => `${group}/${name}`)
      .filter((dir) => fs.existsSync(path.join(repoRoot, dir, "package.json"))),
  ),
];
const declared = (manifest: Manifest) => ({
  ...manifest.dependencies,
  ...manifest.devDependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
});
const rootDeclared = declared(readManifest("."));
// Bins whose package has another name.
const BIN_PACKAGES: Record<string, string> = { tsc: "typescript" };

describe("workspace manifests", () => {
  test.each(workspaceDirs)("%s declares no moving latest version", (dir) => {
    const moving = Object.entries(declared(readManifest(dir))).filter(([, v]) => v === "latest");
    expect(moving).toEqual([]);
  });

  // Undeclared, bunx fetches whatever the registry serves on each run.
  test.each(workspaceDirs)("%s declares every tool its scripts run through bunx", (dir) => {
    const manifest = readManifest(dir);
    const available = { ...rootDeclared, ...declared(manifest) };
    const bins = Object.values(manifest.scripts ?? {}).flatMap((script) =>
      [...script.matchAll(/\bbunx\s+(?:-\S+\s+)*(\S+)/g)].map((match) => match[1]!),
    );
    expect(bins.filter((bin) => !((BIN_PACKAGES[bin] ?? bin) in available))).toEqual([]);
  });
});
