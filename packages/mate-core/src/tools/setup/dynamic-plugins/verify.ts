import fs from "node:fs/promises";

import { FRAMEWORK_NAME } from "../../../framework";
import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { readDeclarations, validateDeclaration } from "./declarations";
import { loadDynamicPlugin, type DynamicPluginLoadDeps } from "./loader";
import { pluginPackageRoot } from "./paths";
import {
  disallowedPluginMessage,
  isPluginAllowed,
  PluginPolicyError,
  readPluginPolicy,
} from "./policy";

export interface PluginVerificationFailure {
  package: string;
  reason: string;
}

export interface PluginInspection {
  failures: PluginVerificationFailure[];
  /** IDs of the capabilities the loaded, allowlisted plugins provide. */
  capabilities: string[];
}

/**
 * Strict, installation-free check of every declared plugin: allowed, installed
 * and loadable with the effective environment. Unlike hydration it fails
 * closed on the first-class problems ordinary commands only warn about. Only
 * allowlisted packages are imported.
 */
export async function verifyDeclaredPlugins(
  companionPath: string,
  deps: DynamicPluginLoadDeps = {},
): Promise<PluginVerificationFailure[]> {
  return (await inspectDeclaredPlugins(companionPath, deps)).failures;
}

export async function inspectDeclaredPlugins(
  companionPath: string,
  deps: DynamicPluginLoadDeps = {},
): Promise<PluginInspection> {
  const env = deps.env ?? process.env;
  const failures: PluginVerificationFailure[] = [];
  const capabilities: string[] = [];
  let policy: ReturnType<typeof readPluginPolicy>;
  try {
    policy = readPluginPolicy(env);
  } catch (error) {
    if (!(error instanceof PluginPolicyError)) throw error;
    return { failures: [{ package: "(allowlist)", reason: error.message }], capabilities };
  }

  const declarations: PluginDeclaration[] = [];
  for (const entry of await readDeclarations(companionPath)) {
    const { declaration, error } = validateDeclaration(entry);
    if (declaration) declarations.push(declaration);
    else failures.push({ package: "(malformed entry)", reason: error ?? "invalid plugins entry" });
  }

  for (const declaration of declarations) {
    const name = declaration.package;
    if (!isPluginAllowed(policy, name)) {
      failures.push({ package: name, reason: disallowedPluginMessage(name) });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- declared order is part of the contract
    const installed = await fs
      .access(pluginPackageRoot(companionPath, name))
      .then(() => true)
      .catch(() => false);
    if (!installed) {
      failures.push({
        package: name,
        reason: `not installed; run setup (\`${FRAMEWORK_NAME} install --yes --frozen-plugins\`) to install it`,
      });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- declared order is part of the contract
    const result = await loadDynamicPlugin(companionPath, declaration, { ...deps, env });
    if (!result.ok) failures.push({ package: name, reason: result.warning });
    else if (result.plugin.kind === "capability") capabilities.push(result.plugin.id);
  }
  return { failures, capabilities };
}
