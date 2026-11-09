import { execFile as execFileCb } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { FRAMEWORK_NAME } from "../../../framework";
import { packPublicPackage } from "../../../lib/public-npm";
import { getUpdateConfig } from "../../../lib/update-checker";
import { mateHome } from "../../../runtime/runtime-directory";

const VSCODE_PACKAGE = "@uniqbit/mate-vscode";
export const VSIX_FILE = "mate-vscode.vsix";

const execFile = promisify(execFileCb);

export interface VsixResolverDeps {
  exists: (file: string) => Promise<boolean>;
  /** Downloads the package tarball into `destination`, returns its path. */
  pack: (spec: string, destination: string) => Promise<string>;
  /** Extracts `package/<VSIX_FILE>` from the tarball to `target`. */
  extract: (tarball: string, target: string) => Promise<void>;
}

async function extractVsix(tarball: string, target: string): Promise<void> {
  const dir = path.dirname(target);
  await execFile("tar", ["-xzf", tarball, "-C", dir, `package/${VSIX_FILE}`]);
  await fs.rename(path.join(dir, "package", VSIX_FILE), target);
  await fs.rm(path.join(dir, "package"), { recursive: true, force: true });
  await fs.rm(tarball, { force: true });
}

export const vsixResolverDeps: VsixResolverDeps = {
  exists: (file) =>
    fs.stat(file).then(
      (stat) => stat.isFile(),
      () => false,
    ),
  pack: (spec, destination) => packPublicPackage(spec, destination, getUpdateConfig().registry),
  extract: extractVsix,
};

function vsixCacheDir(version: string, homeDir?: string): string {
  // `v2`: copies cached before the download ignored repository npm config are not reused.
  return path.join(mateHome(homeDir), "cache", "vscode", "v2", version);
}

export class VsixError extends Error {}

/** SRI form; must match `digestOf` in `apps/mate-vscode/scripts/release-vsix.ts`. */
async function vsixDigest(file: string): Promise<string> {
  return `sha512-${createHash("sha512")
    .update(await fs.readFile(file))
    .digest("base64")}`;
}

/**
 * `--vsix` wins, unchecked; otherwise the cached copy for `version`; otherwise download it from the
 * update registry. With `expectedDigest`, a cached or downloaded VSIX that differs is deleted and refused.
 */
export async function resolveVsix(
  options: {
    vsix?: string;
    version: string;
    expectedDigest?: string | null;
    cacheDir?: string;
    cwd?: string;
  },
  deps: VsixResolverDeps = vsixResolverDeps,
): Promise<string> {
  if (options.vsix) {
    const file = path.resolve(options.cwd ?? process.cwd(), options.vsix);
    if (!(await deps.exists(file))) throw new VsixError(`VSIX not found: ${file}`);
    return file;
  }
  const expected = options.expectedDigest;
  const cacheDir = options.cacheDir ?? vsixCacheDir(options.version);
  const cached = path.join(cacheDir, VSIX_FILE);
  const spec = `${VSCODE_PACKAGE}@${options.version}`;
  if (await deps.exists(cached)) {
    if (!expected || (await vsixDigest(cached)) === expected) return cached;
    await fs.rm(cached, { force: true });
    throw new VsixError(
      `the cached VSIX for ${spec} does not match the digest shipped with Mate ${options.version} and was removed. ` +
        `Nothing was installed. Run \`${FRAMEWORK_NAME} vscode setup\` again to download a fresh copy.`,
    );
  }

  // Checked under a temporary name, so a differing download never becomes the cached copy.
  const pending = path.join(cacheDir, `.${VSIX_FILE}.${randomUUID()}`);
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const tarball = await deps.pack(spec, cacheDir);
    await deps.extract(tarball, pending);
  } catch (error) {
    await fs.rm(pending, { force: true });
    throw new VsixError(
      `could not download ${spec}: ${(error as Error).message.trim()}\n` +
        `Install a local build instead with \`${FRAMEWORK_NAME} vscode setup --vsix <path>\`.`,
    );
  }
  if (expected) {
    const actual = await vsixDigest(pending);
    if (actual !== expected) {
      await fs.rm(pending, { force: true });
      throw new VsixError(
        `${spec} does not match the VSIX digest shipped with Mate ${options.version} (expected ${expected}, got ${actual}). ` +
          `Nothing was installed. Check the npm registry configured for @uniqbit, then run \`${FRAMEWORK_NAME} vscode setup\` again.`,
      );
    }
  }
  await fs.rename(pending, cached);
  return cached;
}
