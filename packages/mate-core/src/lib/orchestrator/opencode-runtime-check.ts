import fs from "node:fs/promises";
import path from "node:path";

import { validateGuidanceData } from "../../runtime/guidance";
import {
  getOpenCodePluginPackageReference,
  isMateOpenCodePluginReference,
} from "../opencode-plugin-package";
import {
  getOpenCodePluginReferences,
  readOpenCodeConfig,
} from "../../tools/setup/providers/opencode-format";
import { buildOpenCodeGuidance } from "./opencode-guidance";
import type { CapabilityConfig } from "./types";

const REQUIRED_RUNTIME_ASSETS = [
  path.join(".opencode", "opencode.json"),
  path.join(".opencode", "tui.json"),
] as const;

async function validatePluginReference(
  companionPath: string,
  configFile: string,
  expectedPluginReference: string,
): Promise<string[]> {
  const configPath = path.join(companionPath, configFile);

  const { present, config } = await readOpenCodeConfig(configPath);
  if (!present) {
    return [`Unreadable OpenCode configuration: ${configPath}`];
  }

  const mateReferences = getOpenCodePluginReferences(config).filter(
    isMateOpenCodePluginReference,
  ) as string[];

  if (mateReferences.includes(expectedPluginReference)) {
    return [];
  }

  if (mateReferences.length > 0) {
    return [
      `Stale Mate plugin package reference in ${configFile}: found ${mateReferences.join(", ")}.`,
    ];
  }

  return [`Missing Mate plugin package reference in ${configFile}.`];
}

/** Self-check the guidance payload so a broken playbook template surfaces as a repair. */
function validateGuidance(capabilities: CapabilityConfig[]): string[] {
  const built = buildOpenCodeGuidance(capabilities);
  const { guidance, errors } = validateGuidanceData(built);

  const needsCodebaseExplorationGuidance = capabilities.some(
    (capability) => capability.name === "graphify" || capability.name === "tokensave",
  );
  if (needsCodebaseExplorationGuidance && !guidance.codebaseExplorationGuidance.trim()) {
    errors.push("missing injected codebase exploration guidance");
  }

  return errors;
}

/**
 * OpenCode companion runtime validation, shared by `mate sync`/doctor
 * (reported repairs) and the deprecated launch preflight. Returns one
 * human-readable problem per invalid asset; empty means valid.
 */
export async function collectOpenCodeRuntimeProblems(
  companionPath: string,
  capabilities: CapabilityConfig[],
): Promise<string[]> {
  const missingAssets = await Promise.all(
    REQUIRED_RUNTIME_ASSETS.map(async (asset) => {
      const assetPath = path.join(companionPath, asset);
      try {
        await fs.access(assetPath);
        return null;
      } catch {
        return assetPath;
      }
    }),
  );
  const missingAsset = missingAssets.find((asset): asset is string => asset !== null);
  if (missingAsset) {
    return [
      `Missing required OpenCode runtime asset: ${missingAsset}. ` +
        "Repair the companion runtime by re-running `mate companion setup` in the companion repository.",
    ];
  }

  const expectedPluginReference = getOpenCodePluginPackageReference();
  const problems = [
    ...(await validatePluginReference(
      companionPath,
      path.join(".opencode", "opencode.json"),
      expectedPluginReference,
    )),
    ...(await validatePluginReference(
      companionPath,
      path.join(".opencode", "tui.json"),
      expectedPluginReference,
    )),
    ...validateGuidance(capabilities),
  ];
  return problems.map(
    (problem) => `${problem} Expected Mate plugin package: ${expectedPluginReference}.`,
  );
}
