import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { FRAMEWORK_NAME } from "../../../framework";
import { packPublicPackage } from "../../../lib/public-npm";
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
  pack: (spec, destination) => packPublicPackage(spec, destination),
  extract: extractVsix,
};

function vsixCacheDir(version: string, homeDir?: string): string {
  return path.join(mateHome(homeDir), "cache", "vscode", version);
}

export class VsixError extends Error {}

/** `--vsix` wins; otherwise the cached copy for `version`; otherwise download it from public npm. */
export async function resolveVsix(
  options: { vsix?: string; version: string; cacheDir?: string; cwd?: string },
  deps: VsixResolverDeps = vsixResolverDeps,
): Promise<string> {
  if (options.vsix) {
    const file = path.resolve(options.cwd ?? process.cwd(), options.vsix);
    if (!(await deps.exists(file))) throw new VsixError(`VSIX not found: ${file}`);
    return file;
  }
  const cacheDir = options.cacheDir ?? vsixCacheDir(options.version);
  const cached = path.join(cacheDir, VSIX_FILE);
  if (await deps.exists(cached)) return cached;

  const spec = `${VSCODE_PACKAGE}@${options.version}`;
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const tarball = await deps.pack(spec, cacheDir);
    await deps.extract(tarball, cached);
  } catch (error) {
    throw new VsixError(
      `could not download ${spec}: ${(error as Error).message.trim()}\n` +
        `Install a local build instead with \`${FRAMEWORK_NAME} vscode setup --vsix <path>\`.`,
    );
  }
  return cached;
}
