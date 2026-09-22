#!/usr/bin/env bun
/**
 * Release hook: keep the image's release-owned inputs at the version being
 * released, and regenerate the npm locks against it.
 *
 * The image installs the published package, so its inputs have to name the
 * release they belong to before the release commit is made. Regenerating the
 * locks here is what stops a rebuild of that tag from silently resolving a
 * newer dependency graph: the tag carries the exact tree it was published with.
 *
 *   bun scripts/sync-image-inputs.ts <version> [workspace-root]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { IMAGE_INPUTS_FILE, readImageInputs } from "../src/image-inputs";

export const LOCK_MANIFESTS = [
  "locks/global-tools.package.json",
  "locks/local-workspace.package.json",
] as const;

/**
 * Rewrites only the `version:` line under `mate:`, so the file keeps its
 * comments — they are most of what makes it readable.
 */
export function withMateVersion(source: string, version: string): string {
  const lines = source.split("\n");
  let inMate = false;
  return lines
    .map((line) => {
      if (/^\S/.test(line)) inMate = /^mate:\s*$/.test(line);
      if (inMate && /^ {2}version:/.test(line)) return `  version: ${version}`;
      return line;
    })
    .join("\n");
}

/** Every dependency in a lock manifest that tracks the Mate release version. */
export function withReleaseVersions(manifest: string, version: string): string {
  const parsed = JSON.parse(manifest) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(parsed.dependencies ?? {})) {
    if (name === "@uniqbit/mate" || name.startsWith("@uniqbit/mate-")) {
      parsed.dependencies![name] = version;
    }
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function main(argv: string[]): number {
  const version = argv[0];
  if (!version) {
    process.stderr.write("sync-image-inputs: a version is required\n");
    return 1;
  }
  const containerRoot = argv[1]
    ? path.resolve(argv[1], "apps", "mate-container")
    : path.resolve(import.meta.dirname, "..");
  const inputsFile = path.join(containerRoot, path.basename(IMAGE_INPUTS_FILE));

  fs.writeFileSync(inputsFile, withMateVersion(fs.readFileSync(inputsFile, "utf8"), version));

  const touched = [inputsFile];
  for (const relative of LOCK_MANIFESTS) {
    const manifest = path.join(containerRoot, relative);
    fs.writeFileSync(manifest, withReleaseVersions(fs.readFileSync(manifest, "utf8"), version));

    // `--package-lock-only` resolves the whole graph without installing it, so
    // the regenerated lock records exact transitive versions and integrity.
    const directory = path.dirname(manifest);
    const stem = path.basename(manifest, ".package.json");
    const scratch = path.join(directory, `.${stem}.sync`);
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    fs.copyFileSync(manifest, path.join(scratch, "package.json"));

    const result = spawnSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], {
      cwd: scratch,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      fs.rmSync(scratch, { recursive: true, force: true });
      process.stderr.write(`sync-image-inputs: resolving ${relative} failed\n`);
      return result.status ?? 1;
    }

    const lock = path.join(directory, `${stem}.package-lock.json`);
    fs.copyFileSync(path.join(scratch, "package-lock.json"), lock);
    fs.rmSync(scratch, { recursive: true, force: true });
    touched.push(manifest, lock);
  }

  const added = spawnSync("git", ["add", ...touched], { stdio: "inherit" });
  if (added.status !== 0) {
    process.stderr.write("sync-image-inputs: git add failed\n");
    return added.status ?? 1;
  }

  const inputs = readImageInputs(inputsFile);
  process.stdout.write(`sync-image-inputs: image inputs pinned to ${inputs.mate.version}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
