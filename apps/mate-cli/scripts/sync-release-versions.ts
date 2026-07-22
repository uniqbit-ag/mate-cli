/**
 * Release hook: keep `@uniqbit/mate-core`, `@uniqbit/mate-opencode-plugin`,
 * and `@uniqbit/mate` at one synchronized version.
 *
 * Runs from apps/mate-cli as release-it's `after:bump` hook. release-it bumps
 * only the CLI package.json; this script propagates the new version to the
 * other public packages and to every inter-package dependency pin, refreshes
 * the lockfile, and stages the touched files so they land in the release
 * commit.
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
const pluginRoot = path.join(workspaceRoot, "apps", "mate-opencode-plugin");

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
const plugin = await readPackageJson(pluginRoot);
const version = cli.version;

core.version = version;

plugin.version = version;
plugin.dependencies = { ...plugin.dependencies, "@uniqbit/mate-core": version };

cli.dependencies = {
  ...cli.dependencies,
  "@uniqbit/mate-core": version,
  "@uniqbit/mate-opencode-plugin": version,
};

await writePackageJson(coreRoot, core);
await writePackageJson(pluginRoot, plugin);
await writePackageJson(cliRoot, cli);

const install = spawnSync("bun", ["install"], { cwd: workspaceRoot, stdio: "inherit" });
if (install.status !== 0) {
  console.error("sync-release-versions: bun install failed after version sync");
  process.exit(install.status ?? 1);
}

const add = spawnSync(
  "git",
  [
    "add",
    path.join(coreRoot, "package.json"),
    path.join(pluginRoot, "package.json"),
    path.join(cliRoot, "package.json"),
    path.join(workspaceRoot, "bun.lock"),
  ],
  { cwd: workspaceRoot, stdio: "inherit" },
);
if (add.status !== 0) {
  console.error("sync-release-versions: git add failed after version sync");
  process.exit(add.status ?? 1);
}

console.log(`sync-release-versions: synchronized all public packages to ${version}`);
