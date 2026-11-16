/**
 * Release hook: keep `@uniqbit/mate-core`, `@uniqbit/mate`, `@uniqbit/mate-vscode`
 * and the Claude manifest of the Companion Mentions mod at one synchronized
 * version. The editor extension is versioned only, never pinned as a dependency.
 *
 * Runs from apps/mate-cli as release-it's `after:bump` hook. release-it bumps
 * only the CLI package.json; this script propagates the new version to the
 * other public packages and dependency pins, updates and checks the lockfile,
 * and stages the touched files for the release commit.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// An explicit workspace root argument makes the script testable against a
// fixture workspace; releases run it without arguments.
const workspaceRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dirname, "..", "..", "..");
const cliRoot = path.join(workspaceRoot, "apps", "mate-cli");
const coreRoot = path.join(workspaceRoot, "packages", "mate-core");
const vscodeRoot = path.join(workspaceRoot, "apps", "mate-vscode");
/** `claude plugin validate --strict` needs a version, and a cached copy is named by it. */
const modManifestPath = path.join(
  coreRoot,
  "claude-capability-plugins",
  "companion-mentions",
  ".claude-plugin",
  "plugin.json",
);

type PackageJson = {
  version: string;
  dependencies?: Record<string, string>;
};

async function readPackageJson(packageRoot: string): Promise<PackageJson> {
  return JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
}

async function writePackageJson(packageRoot: string, data: PackageJson): Promise<void> {
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(data, null, 2) + "\n",
    "utf8",
  );
}

const cli = await readPackageJson(cliRoot);
const core = await readPackageJson(coreRoot);
const vscodeExtension = await readPackageJson(vscodeRoot);
const version = cli.version;

core.version = version;
vscodeExtension.version = version;

cli.dependencies = { ...cli.dependencies, "@uniqbit/mate-core": version };

await writePackageJson(coreRoot, core);
await writePackageJson(vscodeRoot, vscodeExtension);
await writePackageJson(cliRoot, cli);

const modManifest = JSON.parse(await fs.readFile(modManifestPath, "utf8")) as Record<
  string,
  unknown
>;
modManifest.version = version;
await fs.writeFile(modManifestPath, JSON.stringify(modManifest, null, 2) + "\n", "utf8");

const lockPath = path.join(workspaceRoot, "bun.lock");
let lock = await fs.readFile(lockPath, "utf8");
for (const workspace of ["apps/mate-cli", "apps/mate-vscode", "packages/mate-core"]) {
  const blockPattern = new RegExp(`^    "${workspace}": \\{[\\s\\S]*?^    \\},`, "m");
  const block = lock.match(blockPattern)?.[0];
  if (!block) throw new Error(`bun.lock missing workspace ${workspace}`);
  const replaceField = (source: string, pattern: RegExp, field: string): string => {
    if (!pattern.test(source)) throw new Error(`bun.lock missing ${workspace} ${field}`);
    return source.replace(
      pattern,
      (_match, prefix: string) => `${prefix}${JSON.stringify(version)}`,
    );
  };
  let updated = replaceField(block, /^(      "version": )"[^"]*"/m, "version");
  if (workspace === "apps/mate-cli") {
    updated = replaceField(
      updated,
      /^(        "@uniqbit\/mate-core": )"[^"]*"/m,
      "@uniqbit/mate-core dependency",
    );
  }
  lock = lock.replace(block, updated);
}
await fs.writeFile(lockPath, lock, "utf8");

const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
  cwd: workspaceRoot,
  stdio: "inherit",
});
if (install.status !== 0) {
  console.error("sync-release-versions: bun.lock does not match the bumped manifests");
  process.exit(install.status ?? 1);
}

const add = spawnSync(
  "git",
  [
    "add",
    path.join(coreRoot, "package.json"),
    path.join(vscodeRoot, "package.json"),
    path.join(cliRoot, "package.json"),
    modManifestPath,
    path.join(workspaceRoot, "bun.lock"),
  ],
  { cwd: workspaceRoot, stdio: "inherit" },
);
if (add.status !== 0) {
  console.error("sync-release-versions: git add failed after version sync");
  process.exit(add.status ?? 1);
}

console.log(`sync-release-versions: synchronized all public packages to ${version}`);
