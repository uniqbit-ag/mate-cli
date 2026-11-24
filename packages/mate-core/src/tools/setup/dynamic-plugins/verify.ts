import fs from "node:fs/promises";

import { FRAMEWORK_NAME } from "../../../framework";
import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import {
  pluginInstallCommand,
  readAudienceSelection,
  readEffectiveEntries,
  readFrameworkRaw,
} from "./audiences";
import { validateDeclaration } from "./declarations";
import { readLoadableEntries } from "./local";
import { loadDynamicPlugin, type DynamicPluginLoadDeps } from "./loader";
import { pluginPackageRoot, type PluginOrigin } from "./paths";

export interface PluginVerificationFailure {
  package: string;
  reason: string;
}

export interface PluginInspection {
  failures: PluginVerificationFailure[];
  /** IDs of the capabilities the loaded plugins provide. */
  capabilities: string[];
}

export interface PluginInspectionDeps extends DynamicPluginLoadDeps {
  /** Also check this machine's local plugins; doctor does, restores never do. */
  includeLocal?: boolean;
}

/**
 * Strict, installation-free check of every effective plugin (base plus the
 * active `MATE_AUDIENCE`; inactive audiences are not checked): installed
 * and loadable with the effective environment. Unlike hydration it fails
 * closed on the first-class problems ordinary commands only warn about.
 */
export async function verifyDeclaredPlugins(
  companionPath: string,
  deps: DynamicPluginLoadDeps = {},
): Promise<PluginVerificationFailure[]> {
  return (await inspectDeclaredPlugins(companionPath, deps)).failures;
}

export async function inspectDeclaredPlugins(
  companionPath: string,
  deps: PluginInspectionDeps = {},
): Promise<PluginInspection> {
  const env = deps.env ?? process.env;
  const audience = readAudienceSelection(env);
  const { entries, problems } = deps.includeLocal
    ? await readLoadableEntries(companionPath, await readFrameworkRaw(companionPath), audience)
    : { entries: await readEffectiveEntries(companionPath, audience), problems: [] };

  const failures: PluginVerificationFailure[] = problems.map((problem) => ({
    package: problem.package ?? "(local plugins)",
    reason: problem.message,
  }));
  const capabilities: string[] = [];
  const declarations: Array<{ declaration: PluginDeclaration; origin: PluginOrigin }> = [];
  for (const { entry, origin } of entries) {
    const { declaration, error } = validateDeclaration(entry);
    if (declaration) declarations.push({ declaration, origin });
    else failures.push({ package: "(malformed entry)", reason: error ?? "invalid plugins entry" });
  }

  for (const { declaration, origin } of declarations) {
    const name = declaration.package;
    // oxlint-disable-next-line no-await-in-loop -- declared order is part of the contract
    const installed = await fs
      .access(pluginPackageRoot(companionPath, name, origin))
      .then(() => true)
      .catch(() => false);
    if (!installed) {
      const install =
        origin.kind === "local"
          ? pluginInstallCommand(origin)
          : `${FRAMEWORK_NAME} install --yes --frozen-plugins`;
      failures.push({
        package: name,
        reason: `not installed; run setup (\`${install}\`) to install it`,
      });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- declared order is part of the contract
    const result = await loadDynamicPlugin(companionPath, declaration, { ...deps, env }, origin);
    if (!result.ok) failures.push({ package: name, reason: result.warning });
    else if (result.plugin.kind === "capability") capabilities.push(result.plugin.id);
  }
  return { failures, capabilities };
}
