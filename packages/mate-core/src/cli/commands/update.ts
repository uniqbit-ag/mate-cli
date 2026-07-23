import path from "node:path";
import { spawnSync } from "node:child_process";

import { frameworkConfig } from "../../framework";
import {
  OPENCODE_PLUGIN_PACKAGE_NAME,
  warmOpenCodePluginCache,
} from "../../lib/opencode-plugin-package";
import { installPublicPackageSync, isPackageInstalledAtNpmGlobalRoot } from "../../lib/public-npm";
import {
  fetchLatestVersion,
  getCurrentVersion,
  getUpdateConfig,
  isNewer,
} from "../../lib/update-checker";
import { confirmPrompt } from "../../lib/components/confirm-prompt";

type InstallResult = ReturnType<typeof installPublicPackageSync>;

function writeNpmOnlyRecoveryMessage(): void {
  const { packageName, registry } = getUpdateConfig();
  process.stderr.write(
    `${frameworkConfig.name}: self-update is only supported for npm-installed Mate.\n`,
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

export const updateCommandDeps = {
  fetchLatestVersion,
  getCurrentVersion,
  isNewer,
  confirmPrompt,
  isNpmManagedInstall: () =>
    isPackageInstalledAtNpmGlobalRoot(
      path.resolve(import.meta.dirname, "../../.."),
      getUpdateConfig().packageName,
    ),
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
  runPostInstall: (skipConfirm: boolean): InstallResult => {
    const entrypoint = process.argv[1];
    if (!entrypoint?.endsWith("/cli.ts") && !entrypoint?.endsWith("\\cli.ts")) {
      return { status: 0, error: undefined } as InstallResult;
    }
    const args = [entrypoint, "install", ...(skipConfirm ? ["--yes"] : [])];
    return spawnSync(process.execPath, args, { stdio: "inherit" }) as InstallResult;
  },
  warmOpenCodePluginCache: (latest: string) =>
    warmOpenCodePluginCache(latest, process.env, getUpdateConfig().registry),
};

/**
 * @command mate update
 * @description Checks the public npm registry for a newer mate-cli release and
 * self-upgrades only when Mate is running from the npm global installation.
 * @flags
 * - `--check` — only report whether an update is available (exit code 1 if so);
 *   does not install anything.
 * - `--yes` — skip the upgrade confirmation prompt.
 * @remarks Exits with code 1 if the registry is unreachable, npm is
 * unavailable, or the current Mate install is not npm-managed.
 */
export async function runUpdateCommand(argv: string[]): Promise<void> {
  const checkOnly = argv.includes("--check");
  const skipConfirm = argv.includes("--yes");
  const current = updateCommandDeps.getCurrentVersion();

  let latest: string;
  try {
    latest = await updateCommandDeps.fetchLatestVersion();
  } catch {
    process.stderr.write(
      `${frameworkConfig.name}: could not reach registry to check for updates\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    if (updateCommandDeps.isNewer(latest, current)) {
      console.log(`${frameworkConfig.name}: update available (${current} → ${latest})`);
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
        `${frameworkConfig.name}: npm is required for self-update but was not found on PATH\n`,
      );
    } else {
      process.stderr.write(
        `${frameworkConfig.name}: could not verify the npm installation used for self-update\n`,
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

  const result = updateCommandDeps.installLatest(latest);
  if (result.status !== 0 || result.error) {
    process.stderr.write(
      `${frameworkConfig.name}: upgrade command exited with status ${result.status ?? 1}\n`,
    );
    process.exitCode = 1;
    return;
  }

  await updateCommandDeps.saveUpdateState(latest);

  // The plugin package is released in lockstep with the CLI; pre-fetch the
  // newly coordinated version into OpenCode's plugin environment so the next
  // managed launch does not stall on a registry download. Best effort only.
  const warmed = await updateCommandDeps.warmOpenCodePluginCache(latest);
  if (!warmed.ok) {
    process.stderr.write(
      [
        `${frameworkConfig.name}: could not pre-fetch ${OPENCODE_PLUGIN_PACKAGE_NAME}@${latest} for OpenCode.`,
        "The next managed OpenCode launch will download it (requires registry access).",
        ...(warmed.detail ? [`Details: ${warmed.detail}`] : []),
      ].join("\n") + "\n",
    );
  }

  const postInstall = updateCommandDeps.runPostInstall(skipConfirm);
  if (postInstall.status !== 0 || postInstall.error) {
    process.stderr.write(
      `\nUpgraded to ${latest}, but installation is incomplete. Run \`mate install\`.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nUpgraded to ${latest}.`);
  console.log("Post-update installation complete.");
}
