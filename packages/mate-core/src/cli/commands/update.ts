import { spawnSync } from "node:child_process";

import { FRAMEWORK_NAME } from "../../framework";
import { installPublicPackageSync, isPackageInstalledAtNpmGlobalRoot } from "../../lib/public-npm";
import {
  fetchLatestVersion,
  getCurrentVersion,
  getUpdateConfig,
  isNewer,
} from "../../lib/update-checker";
import { confirmPrompt } from "../../lib/components/confirm-prompt";
import { createStartupProgress } from "../../lib/components/startup-progress";
import { releaseTerminal } from "../../lib/live-progress";
import { resolvePackageRoot } from "../../lib/package-root";

type InstallResult = ReturnType<typeof installPublicPackageSync>;

function writeNpmOnlyRecoveryMessage(): void {
  const { packageName, registry } = getUpdateConfig();
  process.stderr.write(
    `${FRAMEWORK_NAME}: self-update is only supported for npm-installed Mate.\n`,
  );
  if (packageName.startsWith("@uniqbit/")) {
    process.stderr.write(
      "If you previously configured the legacy GitLab registry override, remove it first:\n",
    );
    process.stderr.write("  npm config delete @uniqbit:registry --global\n");
  }
  process.stderr.write(
    `Then reinstall with: npm install -g ${packageName} --registry ${registry}\n`,
  );
}

/**
 * Runs a command of the just-installed Mate through this process's entrypoint,
 * which now resolves to the new version; skipped for any other entrypoint.
 */
function runNewEntrypoint(command: string[]): InstallResult {
  const entrypoint = process.argv[1];
  if (!entrypoint || !/(?:^|[\\/])(?:cli\.ts|cli\.mjs|cli-bootstrap\.cjs)$/.test(entrypoint)) {
    return { status: 0, error: undefined } as InstallResult;
  }
  return updateCommandDeps.spawnPostInstall(process.execPath, [entrypoint, ...command]);
}

export const updateCommandDeps = {
  fetchLatestVersion,
  getCurrentVersion,
  isNewer,
  confirmPrompt,
  createProgress: createStartupProgress,
  isNpmManagedInstall: () => {
    const packageName = getUpdateConfig().packageName;
    const packageRoot = resolvePackageRoot(process.argv[1], packageName);
    return packageRoot !== undefined && isPackageInstalledAtNpmGlobalRoot(packageRoot, packageName);
  },
  installLatest: (latest: string): InstallResult => {
    const { packageName, registry } = getUpdateConfig();
    return installPublicPackageSync(`${packageName}@${latest}`, registry);
  },
  saveUpdateState: async (latest: string) => {
    const { UpdateStateStore } = await import("../../lib/update-checker");
    const store = new UpdateStateStore();
    await store.save({
      lastChecked: new Date().toISOString(),
      latestVersion: latest,
    });
  },
  /** Re-runs install from dev (`cli.ts`) or prod (`cli.mjs`/bootstrap) entrypoints so config reconciles during `mate update`. */
  runPostInstall: (skipConfirm: boolean): InstallResult =>
    runNewEntrypoint(["install", ...(skipConfirm ? ["--yes"] : [])]),
  /** Brings an installed VS Code or Cursor extension to the new version; a no-op without one. */
  updateEditorExtension: (): InstallResult =>
    runNewEntrypoint(["vscode", "setup", "--if-installed"]),
  spawnPostInstall: (executable: string, args: string[]): InstallResult =>
    spawnSync(executable, args, { stdio: "inherit" }) as InstallResult,
};

/**
 * @command mate update
 * @description Checks the public npm registry for a newer mate-cli release and
 * self-upgrades only when Mate is running from the npm global installation.
 * Then re-runs `mate install` and updates the Mate extension in each editor
 * (VS Code, Cursor) that has it installed.
 * @flags
 * - `--check` — only report whether an update is available (exit code 1 if so);
 *   does not install anything.
 * - `--yes` — skip the upgrade confirmation prompt.
 * @remarks Exits with code 1 if the registry is unreachable, npm is
 * unavailable, or the current Mate install is not npm-managed.
 */
export async function runUpdateCommand(argv: string[]): Promise<void> {
  const progress = updateCommandDeps.createProgress("Checking for updates");
  try {
    await runUpdate(argv, progress);
  } finally {
    progress.stop();
  }
}

async function runUpdate(
  argv: string[],
  progress: ReturnType<typeof createStartupProgress>,
): Promise<void> {
  const checkOnly = argv.includes("--check");
  const skipConfirm = argv.includes("--yes");
  const current = updateCommandDeps.getCurrentVersion();

  let latest: string;
  try {
    latest = await progress.step("registry", "Checking registry", () =>
      updateCommandDeps.fetchLatestVersion(),
    );
  } catch {
    progress.stop();
    process.stderr.write(`${FRAMEWORK_NAME}: could not reach registry to check for updates\n`);
    process.exitCode = 1;
    return;
  }
  // Saved even when not newer, so a wrong cached version is replaced; a failed write changes nothing.
  await updateCommandDeps.saveUpdateState(latest).catch(() => {});
  // The version lines and the confirm prompt below own the terminal.
  releaseTerminal();

  if (checkOnly) {
    if (updateCommandDeps.isNewer(latest, current)) {
      console.log(`${FRAMEWORK_NAME}: update available (${current} → ${latest})`);
      process.exitCode = 1;
    } else {
      console.log("Up to date.");
    }
    return;
  }

  if (!updateCommandDeps.isNewer(latest, current)) {
    console.log("Already up to date.");
    return;
  }

  console.log(`Current version: ${current}`);
  console.log(`Latest version: ${latest}`);
  console.log("");

  if (!skipConfirm) {
    const ok = await updateCommandDeps.confirmPrompt(`Upgrade ${latest}?`);
    if (!ok) {
      process.stderr.write("Aborted.\n");
      return;
    }
  }

  let isNpmManagedInstall: boolean;
  try {
    isNpmManagedInstall = updateCommandDeps.isNpmManagedInstall();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        `${FRAMEWORK_NAME}: npm is required for self-update but was not found on PATH\n`,
      );
    } else {
      process.stderr.write(
        `${FRAMEWORK_NAME}: could not verify the npm installation used for self-update\n`,
      );
    }
    writeNpmOnlyRecoveryMessage();
    process.exitCode = 1;
    return;
  }

  if (!isNpmManagedInstall) {
    writeNpmOnlyRecoveryMessage();
    process.exitCode = 1;
    return;
  }

  // npm writes straight to the terminal: a labelled hand-over, no spinner.
  progress.handOver("upgrade", `Upgrading to ${latest}`);
  const result = updateCommandDeps.installLatest(latest);
  if (result.status !== 0 || result.error) {
    progress.fail("upgrade");
    process.stderr.write(
      `${FRAMEWORK_NAME}: upgrade command exited with status ${result.status ?? 1}\n`,
    );
    process.exitCode = 1;
    return;
  }
  progress.succeed("upgrade");
  // Post-install renders its own screen.
  progress.stop();

  await updateCommandDeps.saveUpdateState(latest);

  const postInstall = updateCommandDeps.runPostInstall(skipConfirm);
  if (postInstall.status !== 0 || postInstall.error) {
    process.stderr.write(
      `\nUpgraded to ${latest}, but installation is incomplete. Run \`${FRAMEWORK_NAME} install\`.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nUpgraded to ${latest}.`);
  console.log("Post-update installation complete.");
  // The CLI is upgraded either way; a failed extension update only warns.
  const extension = updateCommandDeps.updateEditorExtension();
  if (extension.status !== 0 || extension.error) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: the Mate editor extension was not updated; run \`${FRAMEWORK_NAME} vscode setup\`.\n`,
    );
  }
  /** Managed launches run standalone; only a long-lived service keeps the replaced plugin loaded. */
  console.log(
    "Restart any running OpenCode service to load the new plugin: `opencode service restart`.",
  );
}
