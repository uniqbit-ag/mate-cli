import { confirm } from "../confirm";
import { FRAMEWORK_NAME } from "../../framework";
import {
  buildInstallPlan,
  inspectInstallPlan,
  reconcileInstalledCompanion,
  runInstallPlan,
  saveCompleteInstallState,
  resolveInstallContext,
} from "../../lib/install";
import { renderInstallExecution } from "../install-plan";
import { hydrateDynamicPlugins } from "../../tools/setup/dynamic-plugins/hydrate";
import {
  installDeclaredPlugins,
  type PluginInstallResult,
} from "../../tools/setup/dynamic-plugins/install";
import { registryConfigHint } from "../../tools/setup/dynamic-plugins/registry-hint";

export function reportPluginInstallResults(results: PluginInstallResult[]): void {
  for (const result of results) {
    if (result.status === "failed") {
      process.stderr.write(
        `${FRAMEWORK_NAME}: plugin "${result.package}" failed to install: ${result.error ?? "unknown error"}\n`,
      );
      process.stderr.write(`${registryConfigHint(result.package)}\n`);
    } else if (result.status === "installed") {
      console.log(`  installed plugin ${result.package}@${result.resolvedVersion}`);
    }
  }
}

function printPlanText(plan: Awaited<ReturnType<typeof inspectInstallPlan>>): void {
  if (plan.context.message) process.stderr.write(`${plan.context.message}\n\n`);
  for (const group of ["core", "companion"] as const) {
    const items = plan.requirements.filter((item) => item.group === group);
    if (items.length === 0) continue;
    console.log(`${group === "core" ? "Core" : "Companion"} requirements:`);
    for (const item of items) {
      console.log(`  ${item.satisfied ? "ok" : "missing"} ${item.label}`);
      if (!item.satisfied) console.log(`    ${item.command}`);
    }
  }
}

/**
 * @command mate install
 * @description Installs and verifies the core runtime and dependencies selected by the current companion.
 * @flags
 * - `--yes` — skip confirmation; required for non-TTY execution.
 */
export async function runInstallCommand(argv: string[], cwd = process.cwd()): Promise<boolean> {
  const skipConfirm = argv.includes("--yes");
  const context = await resolveInstallContext(cwd);
  if (context.kind === "ambiguous") {
    process.stderr.write(`${context.message}\n`);
    process.exitCode = 1;
    return false;
  }
  // Companion-declared plugins install first and hydrate into the registry
  // before the plan is built, so one run goes install → load → plan and their
  // own install requirements are part of the plan.
  if (context.kind === "companion" && context.companionPath && context.config.plugins?.length) {
    reportPluginInstallResults(
      await installDeclaredPlugins(context.companionPath, context.config.plugins),
    );
    await hydrateDynamicPlugins({ companionPath: context.companionPath });
  }
  const plan = await inspectInstallPlan(buildInstallPlan(context));
  const missing = plan.requirements.filter((item) => !item.satisfied);
  let execution: Awaited<ReturnType<typeof renderInstallExecution>>;

  if (process.stdout.isTTY) {
    if (missing.length > 0 && !skipConfirm) {
      const ok = await confirm("Install the missing requirements? [y/N] ");
      if (!ok) {
        process.stderr.write(
          `Installation declined. Run \`${FRAMEWORK_NAME} install --yes\` to continue.\n`,
        );
        process.exitCode = 1;
        return false;
      }
    }
    execution = await renderInstallExecution(plan);
  } else {
    printPlanText(plan);
    if (!skipConfirm) {
      process.stderr.write(
        `${FRAMEWORK_NAME}: installation requires confirmation in a TTY. Re-run with \`${FRAMEWORK_NAME} install --yes\`.\n`,
      );
      process.exitCode = 1;
      return false;
    }
    execution = await runInstallPlan(plan, {
      onProgress: (item, result) => {
        const message =
          result.status === "skipped"
            ? "already installed"
            : result.status === "installed"
              ? "installed"
              : "failed";
        console.log(`  ${message}: ${item.label}`);
      },
    });
  }
  if (!execution.ok) {
    for (const result of execution.results.filter((item) => item.status === "failed")) {
      process.stderr.write(
        `${FRAMEWORK_NAME}: ${result.id} failed: ${result.error ?? "unknown error"}\n`,
      );
    }
    process.stderr.write(
      `Installation is incomplete. Re-run \`${FRAMEWORK_NAME} install\` after remediation.\n`,
    );
    process.exitCode = 1;
    return false;
  }

  try {
    await reconcileInstalledCompanion(plan);
    await saveCompleteInstallState(plan, execution.results);
  } catch (error) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: installation completed but companion reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(`Installation is incomplete. Re-run \`${FRAMEWORK_NAME} install\`.\n`);
    process.exitCode = 1;
    return false;
  }

  console.log("Mate installation complete.");
  return true;
}
