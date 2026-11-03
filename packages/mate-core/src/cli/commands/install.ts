import { confirm } from "../confirm";
import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import {
  buildInstallPlan,
  inspectInstallPlan,
  reconcileInstalledCompanion,
  runInstallPlan,
  saveCompleteInstallState,
  resolveInstallContext,
  type InstallContext,
  type InstallPlan,
} from "../../lib/install";
import { MemberChoicesStore, type MemberChoices } from "../../lib/member-choices";
import { renderInstallExecution } from "../install-plan";
import {
  describeUnknownAudience,
  installPluginDeclarations,
  readAudienceSelection,
  resolveAudience,
} from "../../tools/setup/dynamic-plugins/audiences";
import { hydrateDynamicPlugins } from "../../tools/setup/dynamic-plugins/hydrate";
import {
  installDeclaredPlugins,
  type PluginInstallResult,
} from "../../tools/setup/dynamic-plugins/install";
import { registryConfigHint } from "../../tools/setup/dynamic-plugins/registry-hint";
import {
  FrozenInstallError,
  installDeclaredPluginsFrozen,
} from "../../tools/setup/dynamic-plugins/frozen";
import { verifyDeclaredPlugins } from "../../tools/setup/dynamic-plugins/verify";

export function reportPluginInstallResults(results: PluginInstallResult[]): boolean {
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
  return results.every((result) => result.status !== "failed");
}

export interface InstallCommandDeps {
  memberChoicesStore?: MemberChoicesStore;
  confirm?: typeof confirm;
  isTTY?: boolean;
  renderExecution?: typeof renderInstallExecution;
  /** Plan inspection and non-TTY execution; tests stub them instead of shelling out to installers. */
  inspectPlan?: typeof inspectInstallPlan;
  runPlan?: typeof runInstallPlan;
}

/** `--with <id>` / `--without <id>`, repeatable, also as `--with=<id>[,<id>]`. */
export function parseMemberChoiceFlags(argv: string[]): MemberChoices | { error: string } {
  const choices: MemberChoices = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const match = /^--(with|without)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith("--"))
      return { error: `--${match[1]} requires a capability id` };
    for (const id of value.split(",").filter(Boolean)) {
      choices[id] = match[1] === "with" ? "accepted" : "declined";
    }
  }
  return choices;
}

function capabilityLabel(id: string): string {
  return (
    getActiveDistribution()
      .registry.getAll()
      .find((plugin) => plugin.id === id)?.label ?? id
  );
}

/** Capabilities with a deferred requirement the member has not answered yet, in plan order. */
function undecidedCapabilities(plan: InstallPlan): string[] {
  const choices = plan.context.choices ?? {};
  const ids = plan.deferred
    .filter((item) => item.choice === "undecided")
    .flatMap((item) => item.recommendedBy ?? [])
    .filter((id) => choices[id] === undefined);
  return [...new Set(ids)];
}

function deferredCapabilities(plan: InstallPlan, choice: "declined" | "undecided"): string[] {
  const choices = plan.context.choices ?? {};
  const ids = plan.deferred
    .filter((item) => item.choice === choice)
    .flatMap((item) => item.recommendedBy ?? [])
    .filter((id) => (choice === "declined" ? choices[id] === "declined" : !choices[id]));
  return [...new Set(ids)];
}

function printDeferred(plan: InstallPlan): void {
  const undecided = deferredCapabilities(plan, "undecided");
  const declined = deferredCapabilities(plan, "declined");
  if (undecided.length === 0 && declined.length === 0) return;
  console.log("Recommended by this companion, not installed for you:");
  for (const id of undecided) {
    console.log(`  ${capabilityLabel(id)}: not chosen yet`);
    console.log(
      `    \`${FRAMEWORK_NAME} install --with ${id}\` installs it, \`--without ${id}\` stops asking`,
    );
  }
  for (const id of declined) {
    console.log(`  ${capabilityLabel(id)}: declined`);
    console.log(`    \`${FRAMEWORK_NAME} install --with ${id}\` installs it`);
  }
}

async function recordChoices(
  context: InstallContext,
  store: MemberChoicesStore,
  updates: MemberChoices,
): Promise<void> {
  if (Object.keys(updates).length === 0 || !context.companionPath) return;
  context.choices = await store.record(context.companionPath, updates);
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
 * - `--yes` — skip confirmation; required for non-TTY execution. Tools the companion only recommends are not installed by `--yes` alone.
 * - `--with <capability>` — install a tool the companion recommends (RTK, TokenSave, Graphify, Context Mode) and remember the choice. Repeatable.
 * - `--without <capability>` — decline a recommended tool and remember the choice. Repeatable.
 * - `--frozen-plugins` — deployment restore: install declared plugins exactly from the committed lockfile, never rewrite the plugin manifest or lockfile. The checkout's plugin-generated files are written, not committed.
 */
export async function runInstallCommand(
  argv: string[],
  cwd = process.cwd(),
  deps: InstallCommandDeps = {},
): Promise<boolean> {
  const skipConfirm = argv.includes("--yes");
  const frozen = argv.includes("--frozen-plugins");
  const flagChoices = parseMemberChoiceFlags(argv);
  if ("error" in flagChoices) {
    process.stderr.write(`${FRAMEWORK_NAME}: ${flagChoices.error}\n`);
    process.exitCode = 1;
    return false;
  }
  const choicesStore = deps.memberChoicesStore ?? new MemberChoicesStore();
  const askConfirm = deps.confirm ?? confirm;
  const inspectPlan = deps.inspectPlan ?? inspectInstallPlan;
  const runPlan = deps.runPlan ?? runInstallPlan;
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const context = await resolveInstallContext(cwd, { memberChoicesStore: choicesStore });
  if (frozen && context.kind !== "companion") {
    process.stderr.write(`${FRAMEWORK_NAME}: --frozen-plugins requires a companion context.\n`);
    process.exitCode = 1;
    return false;
  }
  if (context.kind === "ambiguous") {
    process.stderr.write(`${context.message}\n`);
    process.exitCode = 1;
    return false;
  }
  if (context.kind === "companion") {
    const audience = resolveAudience(context.config, readAudienceSelection(process.env));
    if (!audience.ok) {
      process.stderr.write(`${FRAMEWORK_NAME}: ${describeUnknownAudience(audience)}\n`);
      process.exitCode = 1;
      return false;
    }
  }
  const declarations =
    context.kind === "companion" || context.kind === "hub"
      ? installPluginDeclarations(context.config)
      : [];
  // Root-declared plugins (companion or hub) install first and hydrate into
  // the registry before the plan is built, so one run goes install → load →
  // plan and their own install requirements are part of the plan.
  if (
    (context.kind === "companion" || context.kind === "hub") &&
    context.companionPath &&
    declarations.length
  ) {
    let results: PluginInstallResult[];
    try {
      results = frozen
        ? await installDeclaredPluginsFrozen(context.companionPath, declarations)
        : await installDeclaredPlugins(context.companionPath, declarations);
    } catch (error) {
      if (!(error instanceof FrozenInstallError)) throw error;
      process.stderr.write(`${FRAMEWORK_NAME}: frozen plugin install refused: ${error.message}\n`);
      process.exitCode = 1;
      return false;
    }
    if (!reportPluginInstallResults(results)) {
      process.stderr.write(
        `${FRAMEWORK_NAME}: a declared plugin failed to install; installation is incomplete.\n`,
      );
      process.exitCode = 1;
      return false;
    }
    await hydrateDynamicPlugins({ companionPath: context.companionPath });
    if (frozen) {
      const failures = await verifyDeclaredPlugins(context.companionPath);
      if (failures.length > 0) {
        for (const failure of failures) {
          process.stderr.write(`${FRAMEWORK_NAME}: plugin ${failure.package}: ${failure.reason}\n`);
        }
        process.exitCode = 1;
        return false;
      }
    }
  }
  await recordChoices(context, choicesStore, flagChoices);
  let plan = await inspectPlan(buildInstallPlan(context));

  // A member answers once per recommended tool; `--yes` alone never accepts one.
  const acceptedNow = new Set<string>();
  if (isTTY && !skipConfirm) {
    const answers: MemberChoices = {};
    for (const id of undecidedCapabilities(plan)) {
      const accepted = await askConfirm(
        `This companion recommends ${capabilityLabel(id)}. Install it for you? [y/N] `,
      );
      answers[id] = accepted ? "accepted" : "declined";
      if (accepted) acceptedNow.add(id);
    }
    if (Object.keys(answers).length > 0) {
      await recordChoices(context, choicesStore, answers);
      plan = await inspectPlan(buildInstallPlan(context));
    }
  }
  printDeferred(plan);

  const missing = plan.requirements.filter((item) => !item.satisfied);
  let execution: Awaited<ReturnType<typeof renderInstallExecution>>;

  if (isTTY) {
    const onlyJustAccepted = missing.every((item) =>
      (item.recommendedBy ?? []).some((id) => acceptedNow.has(id)),
    );
    if (missing.length > 0 && !skipConfirm && !onlyJustAccepted) {
      const ok = await askConfirm("Install the missing requirements? [y/N] ");
      if (!ok) {
        process.stderr.write(
          `Installation declined. Run \`${FRAMEWORK_NAME} install --yes\` to continue.\n`,
        );
        process.exitCode = 1;
        return false;
      }
    }
    execution = await (deps.renderExecution ?? renderInstallExecution)(plan);
  } else {
    printPlanText(plan);
    if (!skipConfirm) {
      process.stderr.write(
        `${FRAMEWORK_NAME}: installation requires confirmation in a TTY. Re-run with \`${FRAMEWORK_NAME} install --yes\`.\n`,
      );
      process.exitCode = 1;
      return false;
    }
    execution = await runPlan(plan, {
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
