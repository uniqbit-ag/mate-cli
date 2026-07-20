import path from "node:path";

import { frameworkConfig } from "../../framework";
import { ConfigStore, defaultConfig } from "../../lib/orchestrator/config-store";
import { executeSetup } from "../../tools/setup";
import {
  inspectSetupPreflight,
  looksLikeWorkingRepo,
} from "../../lib/orchestrator/setup-preflight";
import {
  getSetupSelectionsFromConfig,
  applyOpenSpecSchemaSelection,
} from "../../lib/orchestrator/setup-compatibilities";
import { confirm } from "../confirm";
import { selectCompanion } from "../companion-selector";
import { selectSetupCompatibilities } from "../setup-selector";
import {
  parseAllowedAgents,
  parseCapabilities,
  parseGitMode,
  parseFlags,
  parseOpenSpecSchema,
  parsePackageManagers,
} from "../parse-flags";

interface SetupCommandDependencies {
  confirm?: typeof confirm;
  inspectSetupPreflight?: typeof inspectSetupPreflight;
  looksLikeWorkingRepo?: typeof looksLikeWorkingRepo;
  selectCompanion?: typeof selectCompanion;
  selectSetupCompatibilities?: typeof selectSetupCompatibilities;
  executeSetup?: typeof executeSetup;
}

export const setupCommandDeps = {
  runSetupCommandWithDeps: (argv: string[]) => runSetupCommandWithDeps(argv),
};

/**
 * @command mate companion setup
 * @description Entry point for `mate companion setup`. Delegates to
 * {@link runSetupCommandWithDeps} through the `setupCommandDeps` indirection so
 * tests can inject fake dependencies without mocking module imports.
 */
export async function runSetupCommand(argv: string[]): Promise<void> {
  return setupCommandDeps.runSetupCommandWithDeps(argv);
}

/**
 * @description Drives the `mate companion setup` flow. Detects what kind of directory the
 * command is run in (unrecognized, existing companion, or linked working repo) via
 * {@link inspectSetupPreflight}, prompting to confirm initialization for an
 * unrecognized directory. Resolves agent/package-manager/capability selections
 * either from CLI flags (non-interactive) or from the interactive
 * `selectSetupCompatibilities` picker, seeded from the existing config when one
 * exists. Writes the resulting config via `setup.execute` and prints a summary
 * table of profiles, package managers, and capabilities.
 * @flags
 * - `--agents <list>` — parsed via `parseAllowedAgents`.
 * - `--package-managers <list>` — parsed via `parsePackageManagers`.
 * - `--capabilities <list>` — parsed via `parseCapabilities`.
 * - `--openspec-schema <value>` — parsed via `parseOpenSpecSchema`.
 * - `--git-mode <value>` — parsed via `parseGitMode`.
 * @remarks When any flag above is present, the whole selection is treated as
 * explicit and the interactive picker is skipped.
 */
export async function runSetupCommandWithDeps(
  argv: string[],
  deps: SetupCommandDependencies = {},
): Promise<void> {
  return runSetupFlow(path.resolve(process.cwd()), argv, deps);
}

export async function runSetupFlowAtPath(
  cwd: string,
  deps: SetupCommandDependencies = {},
): Promise<void> {
  return runSetupFlow(path.resolve(cwd), [], deps);
}

async function runSetupFlow(
  cwd: string,
  argv: string[],
  deps: SetupCommandDependencies = {},
): Promise<void> {
  const inspect = deps.inspectSetupPreflight ?? inspectSetupPreflight;
  const checkWorkingRepo = deps.looksLikeWorkingRepo ?? looksLikeWorkingRepo;
  const askConfirm = deps.confirm ?? confirm;
  const chooseCompanion = deps.selectCompanion ?? selectCompanion;
  const selectCompatibilities = deps.selectSetupCompatibilities ?? selectSetupCompatibilities;
  const runExecuteSetup = deps.executeSetup ?? executeSetup;

  const preflight = await inspect(cwd);
  if (preflight.kind === "unrecognized") {
    if (await checkWorkingRepo(cwd)) {
      process.stderr.write(
        `Warning: this directory looks like a working repository (project files detected).\n` +
          `Initializing it as a ${frameworkConfig.name} companion here may not be what you want.\n`,
      );
    }
    const ok = await askConfirm("Initialize this directory as a Mate companion repository? [y/N] ");
    if (!ok) {
      process.stderr.write("Aborted.\n");
      process.exit(1);
    }
  }

  const flags = parseFlags(argv);
  const flagAllowedAgents = parseAllowedAgents(flags);
  const flagPackageManagers = parsePackageManagers(flags);
  const flagCapabilities = parseCapabilities(flags);
  const flagOpenSpecSchema = parseOpenSpecSchema(flags);
  const flagGitMode = parseGitMode(flags);
  const hasExplicitSelections =
    flagAllowedAgents !== undefined ||
    flagPackageManagers !== undefined ||
    flagCapabilities !== undefined ||
    flagOpenSpecSchema !== undefined ||
    flagGitMode !== undefined;

  if (preflight.kind === "linked-working-repo") {
    let companion = preflight.match;
    const ambiguousMatches = preflight.ambiguousMatches ?? [];
    if (ambiguousMatches.length > 1) {
      const selected = await chooseCompanion(ambiguousMatches);
      if (!selected) {
        process.stderr.write("Aborted.\n");
        process.exit(1);
      }
      companion = selected;
    }

    const linkedCapabilities =
      flagCapabilities ??
      (flagOpenSpecSchema === undefined
        ? undefined
        : getSetupSelectionsFromConfig(
            await new ConfigStore(
              path.join(
                companion.companionPath,
                `.${frameworkConfig.name}`,
                "config",
                "framework.yaml",
              ),
            ).load(),
          ).capabilities);

    await runExecuteSetup(
      {
        allowedAgents: flagAllowedAgents,
        packageManagers: flagPackageManagers,
        capabilities:
          linkedCapabilities === undefined
            ? undefined
            : applyOpenSpecSchemaSelection(linkedCapabilities, flagOpenSpecSchema),
        git: flagGitMode,
      },
      { cwd: companion.companionPath },
    );
    return;
  }

  const currentSelections =
    preflight.kind === "existing-companion"
      ? getSetupSelectionsFromConfig(
          await new ConfigStore(
            path.join(cwd, `.${frameworkConfig.name}`, "config", "framework.yaml"),
          ).load(),
        )
      : getSetupSelectionsFromConfig(defaultConfig());

  const selections = hasExplicitSelections
    ? {
        allowedAgents: flagAllowedAgents ?? currentSelections.allowedAgents,
        packageManagers: flagPackageManagers ?? currentSelections.packageManagers,
        capabilities: applyOpenSpecSchemaSelection(
          flagCapabilities ?? currentSelections.capabilities,
          flagOpenSpecSchema,
        ),
        git: flagGitMode ?? currentSelections.selectedGitMode,
        selectedOpenSpecSchema: flagOpenSpecSchema ?? currentSelections.selectedOpenSpecSchema,
        selectedGitMode: flagGitMode ?? currentSelections.selectedGitMode,
      }
    : await selectCompatibilities({ initialSelections: currentSelections });

  if (!selections) {
    process.stderr.write("Aborted.\n");
    process.exit(1);
  }

  const result = await runExecuteSetup(
    {
      allowedAgents: selections.allowedAgents,
      packageManagers: selections.packageManagers,
      capabilities: selections.capabilities,
      git: selections.selectedGitMode,
    },
    { cwd },
  );

  const { config } = result;
  const rows: [string, string][] = [];

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    rows.push([`profile:${profileName}`, (profile.allowedAgents ?? []).join(", ") || "(none)"]);
  }

  const capabilities = config.capabilities ?? [];
  rows.push(["packageManagers", (config.packageManagers ?? ["bun"]).join(", ") || "(none)"]);
  rows.push(["capabilities", capabilities.map((c) => c.name).join(", ") || "(none)"]);

  const keyWidth = Math.max(...rows.map(([k]) => k.length));
  console.log();
  for (const [key, value] of rows) {
    console.log(`  ${key.padEnd(keyWidth)}  ${value}`);
  }
  console.log();
}
