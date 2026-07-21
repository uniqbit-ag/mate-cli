import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import packageJson from "../../package.json";
import { defaultConfig, ConfigStore, mergeWithDefaults } from "./orchestrator/config-store";
import { CompanionResolver } from "./orchestrator/companion-resolver";
import { checkMateEngineRequirement } from "./orchestrator/engine-guard";
import { GlobalConfigStore } from "./orchestrator/global-config-store";
import { YamlFileStore } from "./orchestrator/yaml-file-store";
import { frameworkConfig } from "../framework";
import type { FrameworkConfig } from "./orchestrator/types";
import { registry } from "../tools/setup/registry";
import { bunPlugin } from "../tools/setup/package-managers/bun";
import type { InstallRequirement } from "../tools/setup/install-contract";
import type { Plugin } from "../tools/setup/plugin";

export const INSTALL_CONTRACT_REVISION = 1;

export interface InstallContext {
  kind: "core" | "companion" | "ambiguous";
  companionPath?: string;
  config: FrameworkConfig;
  fingerprint: string;
  message?: string;
}

export type InstallStateScope = Pick<InstallContext, "kind" | "companionPath">;

export interface InstallPlanItem extends InstallRequirement {
  satisfied: boolean;
  error?: string;
}

export interface InstallPlan {
  context: InstallContext;
  requirements: InstallPlanItem[];
  fingerprint: string;
}

export interface InstallRequirementResult {
  id: string;
  status: "installed" | "skipped" | "failed";
  verified: boolean;
  error?: string;
}

export interface InstallState {
  contractRevision: number;
  mateVersion: string;
  completedAt: string;
  contextFingerprint: string;
  requirementFingerprint: string;
  requirements: InstallRequirementResult[];
}

function defaultInstallStateRoot(): string {
  return path.join(os.homedir(), `.${frameworkConfig.name}`, "install-state");
}

export function getInstallStatePath(
  scope: InstallStateScope,
  stateRoot = defaultInstallStateRoot(),
): string {
  if (scope.kind === "ambiguous") {
    throw new Error("cannot resolve install state for an ambiguous companion context");
  }
  const key =
    scope.kind === "companion" && scope.companionPath
      ? fingerprint({ kind: "companion", companionPath: path.resolve(scope.companionPath) })
      : "core";
  return path.join(stateRoot, `${key}.yaml`);
}

export function installStateStoreForContext(
  context: InstallStateScope,
  stateRoot?: string,
): InstallStateStore {
  return new InstallStateStore(getInstallStatePath(context, stateRoot));
}

export class InstallStateStore extends YamlFileStore<InstallState> {
  constructor(configPath = getInstallStatePath({ kind: "core" })) {
    super(configPath);
  }

  protected onMissing(): Promise<InstallState> {
    return Promise.reject(Object.assign(new Error("install state is missing"), { code: "ENOENT" }));
  }
}

export interface InstallContextDeps {
  globalConfigStore?: GlobalConfigStore;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function coreContext(): InstallContext {
  const config = defaultConfig();
  return {
    kind: "core",
    config: { ...config, packageManagers: [], capabilities: [] },
    fingerprint: fingerprint({ kind: "core" }),
  };
}

async function contextForCompanion(companionPath: string): Promise<InstallContext> {
  const configPath = path.join(
    companionPath,
    `.${frameworkConfig.name}`,
    "config",
    "framework.yaml",
  );
  const config = mergeWithDefaults(await new ConfigStore(configPath).load());
  return {
    kind: "companion",
    companionPath,
    config,
    fingerprint: fingerprint({ kind: "companion", companionPath, config }),
  };
}

async function hasLocalConfig(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, `.${frameworkConfig.name}`, "config", "framework.yaml"));
    return true;
  } catch {
    return false;
  }
}

export async function resolveInstallContext(
  cwd = process.cwd(),
  deps: InstallContextDeps = {},
): Promise<InstallContext> {
  const resolvedCwd = path.resolve(cwd);
  const envCompanionPath = process.env.MATE_ARTIFACT_PATH;
  if (envCompanionPath) return contextForCompanion(path.resolve(envCompanionPath));

  const resolver = new CompanionResolver(deps.globalConfigStore ?? new GlobalConfigStore());
  const resolution = await resolver.resolveWithDiagnostics(resolvedCwd);
  if (resolution.ambiguousMatches.length > 1) {
    return {
      ...coreContext(),
      kind: "ambiguous",
      message: [
        "multiple companions match the current working repository.",
        ...resolution.ambiguousMatches.map((match) => `  - ${match.companionPath}`),
        "Run `mate install` from an explicit companion context or set MATE_ARTIFACT_PATH.",
      ].join("\n"),
    };
  }
  if (resolution.match) return contextForCompanion(resolution.match.companionPath);
  if (await hasLocalConfig(resolvedCwd)) return contextForCompanion(resolvedCwd);
  return coreContext();
}

export function buildInstallPlan(
  context: InstallContext,
  plugins: Plugin[] = registry.getAll(),
): InstallPlan {
  const requirements: InstallRequirement[] = [];
  const allPlugins = [bunPlugin, ...plugins.filter((plugin) => plugin.id !== bunPlugin.id)];
  for (const plugin of allPlugins) {
    if (plugin.id !== "bun" && !plugin.isEnabled(context.config)) continue;
    requirements.push(
      ...(plugin.getInstallRequirements?.({
        companionPath: context.companionPath,
        config: context.config,
      }) ?? []),
    );
  }

  const unique = [
    ...new Map(requirements.map((requirement) => [requirement.id, requirement])).values(),
  ];
  const items: InstallPlanItem[] = unique.map((requirement) => ({
    ...requirement,
    satisfied: false,
  }));
  return {
    context,
    requirements: items,
    fingerprint: fingerprint(
      unique.map((requirement) => ({
        id: requirement.id,
        command: requirement.command,
        fingerprint: requirement.fingerprint,
      })),
    ),
  };
}

export async function inspectInstallPlan(plan: InstallPlan): Promise<InstallPlan> {
  for (const item of plan.requirements) {
    try {
      item.satisfied = await item.detect();
      if (item.satisfied && item.verify) item.satisfied = await item.verify();
    } catch (error) {
      item.satisfied = false;
      item.error = error instanceof Error ? error.message : String(error);
    }
  }
  return plan;
}

export async function readInstallState(
  store = new InstallStateStore(),
): Promise<InstallState | null> {
  try {
    return await store.load();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function invalidateInstallState(
  scopeOrStore: InstallStateScope | InstallStateStore = { kind: "core" },
  store?: InstallStateStore,
): Promise<void> {
  const stateStore =
    scopeOrStore instanceof InstallStateStore
      ? scopeOrStore
      : (store ?? installStateStoreForContext(scopeOrStore));
  await fs.rm(stateStore.configPath, { force: true });
}

export async function runInstallPlan(
  plan: InstallPlan,
  options: {
    stateStore?: InstallStateStore;
    onStart?: (item: InstallPlanItem) => void;
    onProgress?: (item: InstallPlanItem, result: InstallRequirementResult) => void;
  } = {},
): Promise<{ ok: boolean; results: InstallRequirementResult[] }> {
  const results: InstallRequirementResult[] = [];
  let ok = true;
  for (const item of plan.requirements) {
    options.onStart?.(item);
    if (item.satisfied) {
      const result = { id: item.id, status: "skipped" as const, verified: true };
      results.push(result);
      options.onProgress?.(item, result);
      continue;
    }
    let result: InstallRequirementResult;
    try {
      await item.install();
      const verified = item.verify ? await item.verify() : await item.detect();
      if (!verified) throw new Error("requirement is still unavailable after installation");
      result = { id: item.id, status: "installed", verified: true };
    } catch (error) {
      ok = false;
      result = {
        id: item.id,
        status: "failed",
        verified: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(result);
    options.onProgress?.(item, result);
  }
  return { ok, results };
}

export async function saveCompleteInstallState(
  plan: InstallPlan,
  results: InstallRequirementResult[],
  store?: InstallStateStore,
): Promise<void> {
  await (store ?? installStateStoreForContext(plan.context)).save({
    contractRevision: INSTALL_CONTRACT_REVISION,
    mateVersion: packageJson.version,
    completedAt: new Date().toISOString(),
    contextFingerprint: plan.context.fingerprint,
    requirementFingerprint: plan.fingerprint,
    requirements: results,
  });
}

export interface InstallPreflightResult {
  ok: boolean;
  reason?: string;
  plan?: InstallPlan;
}

export async function inspectInstallPreflight(
  cwd = process.cwd(),
  deps: { stateStore?: InstallStateStore; globalConfigStore?: GlobalConfigStore } = {},
): Promise<InstallPreflightResult> {
  const context = await resolveInstallContext(cwd, deps);
  const engineCheck = checkMateEngineRequirement(context.config, packageJson.version);
  if (!engineCheck.ok) return { ok: false, reason: engineCheck.reason };
  const plan = await inspectInstallPlan(buildInstallPlan(context));
  if (context.kind === "ambiguous") return { ok: false, reason: context.message, plan };
  const state = await readInstallState(deps.stateStore ?? installStateStoreForContext(context));
  if (!state) {
    const missing = plan.requirements.filter((requirement) => !requirement.satisfied);
    return {
      ok: false,
      reason:
        missing.length > 0
          ? `Mate has not been installed for this environment. Missing: ${missing.map((item) => item.label).join(", ")}.`
          : "Mate has not been installed for this environment.",
      plan,
    };
  }
  if (state.contractRevision !== INSTALL_CONTRACT_REVISION) {
    return { ok: false, reason: "Mate's install contract has changed.", plan };
  }
  if (state.contextFingerprint !== context.fingerprint) {
    return { ok: false, reason: "The active companion installation context has changed.", plan };
  }
  if (state.requirementFingerprint !== plan.fingerprint) {
    return { ok: false, reason: "The required dependency plan has changed.", plan };
  }
  const missing = plan.requirements.filter((requirement) => !requirement.satisfied);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Missing required dependency: ${missing.map((item) => item.label).join(", ")}.`,
      plan,
    };
  }
  return { ok: true, plan };
}

export async function reconcileInstalledCompanion(plan: InstallPlan): Promise<void> {
  if (plan.context.kind === "companion" && plan.context.companionPath) {
    const { syncCompanionFiles } = await import("../tools/setup");
    await syncCompanionFiles(plan.context.companionPath, plan.context.config);
  }
}
