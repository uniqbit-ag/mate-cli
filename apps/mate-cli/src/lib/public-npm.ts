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

function getPublicNpmUserConfig(): string {
  return `registry=${PUBLIC_NPM_REGISTRY}\n@uniqbit:registry=${PUBLIC_NPM_REGISTRY}\n`;
}

async function withPublicNpmConfig<T>(run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const tempDir = await publicNpmDeps.mkdtemp(path.join(os.tmpdir(), "mate-public-npm-"));
  const userConfigPath = path.join(tempDir, ".npmrc");

  await publicNpmDeps.writeFile(userConfigPath, getPublicNpmUserConfig(), "utf8");

  try {
    return await run({
      ...process.env,
      NPM_CONFIG_USERCONFIG: userConfigPath,
    });
  } finally {
    await publicNpmDeps.rm(tempDir, { recursive: true, force: true });
  }
}

function withPublicNpmConfigSync<T>(run: (env: NodeJS.ProcessEnv) => T): T {
  const tempDir = publicNpmDeps.mkdtempSync(path.join(os.tmpdir(), "mate-public-npm-"));
  const userConfigPath = path.join(tempDir, ".npmrc");

  publicNpmDeps.writeFileSync(userConfigPath, getPublicNpmUserConfig(), "utf8");

  try {
    return run({
      ...process.env,
      NPM_CONFIG_USERCONFIG: userConfigPath,
    });
  } finally {
    publicNpmDeps.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function fetchPublicPackageVersion(packageName: string): Promise<string> {
  const { stdout } = await withPublicNpmConfig((env) =>
    publicNpmDeps.execFile("npm", ["view", packageName, "version"], {
      timeout: 10_000,
      env,
    }),
  );

  return stdout.trim();
}

export function installPublicPackageSync(packageSpec: string) {
  return withPublicNpmConfigSync((env) =>
    publicNpmDeps.spawnSync("npm", ["install", "-g", packageSpec], {
      stdio: "inherit",
      env,
    }),
  );
}

export function getNpmGlobalPackageRootSync(packageName: string): string {
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
