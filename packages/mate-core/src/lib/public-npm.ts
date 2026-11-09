import {
  execFile as execFileCb,
  execFileSync as execFileSyncCb,
  spawnSync as spawnSyncCb,
} from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

export const publicNpmDeps = {
  execFile,
  execFileSync: execFileSyncCb,
  spawnSync: spawnSyncCb,
  mkdtemp,
  writeFile,
  rm,
  existsSync: fs.existsSync,
  realpathSync: fs.realpathSync,
  mkdtempSync: fs.mkdtempSync,
  writeFileSync: fs.writeFileSync,
  rmSync: fs.rmSync,
};

function packageNameFromSpec(packageSpec: string): string {
  const separator = packageSpec.startsWith("@")
    ? packageSpec.indexOf("@", 1)
    : packageSpec.indexOf("@");
  return separator === -1 ? packageSpec : packageSpec.slice(0, separator);
}

function packageScope(packageName: string): string | null {
  return packageName.startsWith("@") ? packageName.slice(0, packageName.indexOf("/")) : null;
}

function getPublicNpmUserConfig(packageName: string, registry: string): string {
  const scope = packageScope(packageName);
  return [`registry=${registry}`, ...(scope ? [`${scope}:registry=${registry}`] : []), ""].join(
    "\n",
  );
}

/** CLI flags outrank project config and `npm_config_*` variables. */
function getRegistryFlags(packageName: string, registry: string): string[] {
  const scope = packageScope(packageName);
  return [`--registry=${registry}`, ...(scope ? [`--${scope}:registry=${registry}`] : [])];
}

const ISOLATED_DIR_PREFIX = "mate-public-npm-";
/** Makes the directory npm's `localPrefix`, so npm stops its upward project-config search there. */
const EMPTY_PACKAGE_JSON = "{}\n";

/**
 * Runs `run` in a fresh temporary directory that holds only an empty `package.json`, so a
 * package manager started there reads no project config from the caller's directory.
 */
async function withIsolatedPackageDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await publicNpmDeps.mkdtemp(path.join(os.tmpdir(), ISOLATED_DIR_PREFIX));
  try {
    await publicNpmDeps.writeFile(path.join(dir, "package.json"), EMPTY_PACKAGE_JSON, "utf8");
    return await run(dir);
  } finally {
    await publicNpmDeps.rm(dir, { recursive: true, force: true });
  }
}

function withIsolatedPackageDirSync<T>(run: (dir: string) => T): T {
  const dir = publicNpmDeps.mkdtempSync(path.join(os.tmpdir(), ISOLATED_DIR_PREFIX));
  try {
    publicNpmDeps.writeFileSync(path.join(dir, "package.json"), EMPTY_PACKAGE_JSON, "utf8");
    return run(dir);
  } finally {
    publicNpmDeps.rmSync(dir, { recursive: true, force: true });
  }
}

interface PublicNpmOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

// Not named `.npmrc`, so npm does not also read the pin as the project config.
const USER_CONFIG_FILE = "user.npmrc";

function publicNpmOptions(dir: string): PublicNpmOptions {
  return {
    cwd: dir,
    env: { ...process.env, NPM_CONFIG_USERCONFIG: path.join(dir, USER_CONFIG_FILE) },
  };
}

function withPublicNpmConfig<T>(
  packageName: string,
  registry: string,
  run: (options: PublicNpmOptions) => Promise<T>,
): Promise<T> {
  return withIsolatedPackageDir(async (dir) => {
    await publicNpmDeps.writeFile(
      path.join(dir, USER_CONFIG_FILE),
      getPublicNpmUserConfig(packageName, registry),
      "utf8",
    );
    return run(publicNpmOptions(dir));
  });
}

function withPublicNpmConfigSync<T>(
  packageName: string,
  registry: string,
  run: (options: PublicNpmOptions) => T,
): T {
  return withIsolatedPackageDirSync((dir) => {
    publicNpmDeps.writeFileSync(
      path.join(dir, USER_CONFIG_FILE),
      getPublicNpmUserConfig(packageName, registry),
      "utf8",
    );
    return run(publicNpmOptions(dir));
  });
}

export async function fetchPublicPackageVersion(
  packageName: string,
  registry = PUBLIC_NPM_REGISTRY,
  distTag = "latest",
): Promise<string> {
  const { stdout } = await withPublicNpmConfig(packageName, registry, (options) =>
    publicNpmDeps.execFile(
      "npm",
      ["view", `${packageName}@${distTag}`, "version", ...getRegistryFlags(packageName, registry)],
      { timeout: 10_000, ...options },
    ),
  );

  return stdout.trim();
}

/** `npm pack` a package from `registry` into `destination`; returns the tarball path. */
export async function packPublicPackage(
  packageSpec: string,
  destination: string,
  registry = PUBLIC_NPM_REGISTRY,
): Promise<string> {
  const packageName = packageNameFromSpec(packageSpec);
  const packDestination = path.resolve(destination);
  const { stdout } = await withPublicNpmConfig(packageName, registry, (options) =>
    publicNpmDeps.execFile(
      "npm",
      [
        "pack",
        packageSpec,
        "--pack-destination",
        packDestination,
        ...getRegistryFlags(packageName, registry),
      ],
      { timeout: 120_000, ...options },
    ),
  );
  const tarball = stdout.trim().split("\n").at(-1)?.trim();
  if (!tarball) throw new Error(`npm pack ${packageSpec} printed no tarball name`);
  return path.join(packDestination, tarball);
}

export function installPublicPackageSync(packageSpec: string, registry = PUBLIC_NPM_REGISTRY) {
  return withPublicNpmConfigSync(packageNameFromSpec(packageSpec), registry, (options) =>
    publicNpmDeps.spawnSync("npm", ["install", "-g", packageSpec], {
      stdio: "inherit",
      ...options,
    }),
  );
}

function getNpmGlobalPackageRootSync(packageName: string): string {
  const npmRoot = publicNpmDeps
    .execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
    })
    .trim();

  return path.join(npmRoot, packageName);
}

export function isPackageInstalledAtNpmGlobalRoot(
  packageRoot: string,
  packageName: string,
): boolean {
  const globalPackageRoot = getNpmGlobalPackageRootSync(packageName);
  if (!publicNpmDeps.existsSync(globalPackageRoot)) return false;

  return publicNpmDeps.realpathSync(packageRoot) === publicNpmDeps.realpathSync(globalPackageRoot);
}
