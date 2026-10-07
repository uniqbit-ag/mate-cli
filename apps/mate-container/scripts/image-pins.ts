#!/usr/bin/env bun
/**
 * Image pin entries over `src/image-pins.ts`.
 *
 *   bun scripts/image-pins.ts sync <version> [workspace-root]
 *     Release preparation: pin the image inputs and locks to local packs of
 *     <version>, then stage them.
 *
 *   bun scripts/image-pins.ts verify <version> <pack-dir> [workspace-root]
 *     Publication: pack each release package once into <pack-dir>, check it
 *     against the image locks, and print `name\tintegrity\ttarball` per
 *     package in publish order.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  IMAGE_LOCKS,
  packRelease,
  readImageLocks,
  RELEASE_PACKAGES,
  stalePins,
  unpinned,
  withMateVersion,
  withPublishedPackageVersions,
  withReleaseVersions,
  type NpmRunner,
  type PackageMetadata,
} from "../src/image-pins";

export type EntryDeps = {
  runNpm?: NpmRunner;
  stage: (files: readonly string[]) => number | null;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const defaultDeps: EntryDeps = {
  stage: (files) => spawnSync("git", ["add", ...files], { stdio: "inherit" }).status,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function roots(workspaceArg: string | undefined): { containerRoot: string; workspaceRoot: string } {
  const containerRoot = workspaceArg
    ? path.resolve(workspaceArg, "apps", "mate-container")
    : path.resolve(import.meta.dirname, "..");
  return { containerRoot, workspaceRoot: path.resolve(containerRoot, "..", "..") };
}

export async function sync(argv: string[], deps: EntryDeps = defaultDeps): Promise<number> {
  const [version, workspaceArg] = argv;
  if (!version) {
    deps.stderr("sync-image-inputs: a version is required\n");
    return 1;
  }
  const { containerRoot, workspaceRoot } = roots(workspaceArg);
  const { IMAGE_INPUTS_FILE, readImageInputs } = await import("../src/image-inputs");
  const inputsFile = path.join(containerRoot, path.basename(IMAGE_INPUTS_FILE));

  const packages: PackageMetadata[] = RELEASE_PACKAGES.map(({ dir }) =>
    JSON.parse(fs.readFileSync(path.join(workspaceRoot, dir, "package.json"), "utf8")),
  );
  if (packages.some((packageData) => packageData.version !== version)) {
    deps.stderr(`sync-image-inputs: public packages are not all at ${version}\n`);
    return 1;
  }

  const locks = readImageLocks(containerRoot);
  const missing = unpinned(
    locks,
    RELEASE_PACKAGES.map(({ name }) => name),
  );
  if (missing.length > 0) {
    deps.stderr(`sync-image-inputs: no image lock pins ${missing.join(", ")}\n`);
    return 1;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mate-release-packages-"));
  let packed;
  try {
    packed = packRelease(version, workspaceRoot, scratch, { runNpm: deps.runNpm });
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n`);
    return 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const integrities = new Map([...packed].map(([name, { integrity }]) => [name, integrity]));
  const outputs = new Map<string, string>();
  outputs.set(inputsFile, withMateVersion(fs.readFileSync(inputsFile, "utf8"), version));
  for (const { manifest, lock } of IMAGE_LOCKS) {
    const manifestFile = path.join(containerRoot, manifest);
    outputs.set(manifestFile, withReleaseVersions(fs.readFileSync(manifestFile, "utf8"), version));
    outputs.set(
      path.join(containerRoot, lock),
      withPublishedPackageVersions(locks.get(lock)!, version, packages, integrities),
    );
  }

  for (const [file, contents] of outputs) fs.writeFileSync(file, contents);

  const staged = deps.stage([...outputs.keys()]);
  if (staged !== 0) {
    deps.stderr("sync-image-inputs: git add failed\n");
    return staged ?? 1;
  }

  const inputs = readImageInputs(inputsFile);
  deps.stdout(`sync-image-inputs: image inputs pinned to ${inputs.mate.version}\n`);
  return 0;
}

export async function verify(argv: string[], deps: EntryDeps = defaultDeps): Promise<number> {
  const [version, packDir, workspaceArg] = argv;
  if (!version || !packDir) {
    deps.stderr("Error: image-pins verify needs <version> <pack-dir>.\n");
    return 1;
  }
  const { containerRoot, workspaceRoot } = roots(workspaceArg);

  let packed;
  try {
    packed = packRelease(version, workspaceRoot, path.resolve(packDir), { runNpm: deps.runNpm });
  } catch (error) {
    deps.stderr(`Error: ${(error as Error).message}\n`);
    return 1;
  }

  const locks = readImageLocks(containerRoot);
  const missing = unpinned(locks, [...packed.keys()]);
  for (const name of missing) {
    deps.stderr(`Error: no image lock pins ${name}.\n`);
  }

  const stale = stalePins(locks, version, packed);
  for (const { name, integrity, staleLocks } of stale) {
    const lockNames = staleLocks.map((lock) => path.basename(lock)).join(", ");
    deps.stderr(
      `Error: ${name}@${version} would publish as ${integrity}, but ${lockNames} pin another tarball.\n`,
    );
  }
  if (stale.length > 0) {
    deps.stderr(
      "The tagged tree does not pack to the tarball pinned at the version bump; nothing was published.\n",
    );
  }
  if (missing.length > 0 || stale.length > 0) return 1;

  for (const [name, { integrity, tarball }] of packed) {
    deps.stdout(`${name}\t${integrity}\t${tarball}\n`);
  }
  return 0;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const entries: Record<string, typeof sync> = { sync, verify };
  const entry = command ? entries[command] : undefined;
  if (!entry) {
    process.stderr.write("Usage: bun scripts/image-pins.ts <sync|verify> ...\n");
    process.exit(1);
  }
  process.exit(await entry(rest));
}
