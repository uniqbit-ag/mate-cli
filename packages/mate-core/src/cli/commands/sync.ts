import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { ConfigStore, mergeWithDefaults } from "../../lib/orchestrator/config-store";
import { CompanionResolver } from "../../lib/orchestrator/companion-resolver";
import { syncCompanionGit } from "../../lib/orchestrator/companion-git-sync";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { collectOpenCodeRuntimeProblems } from "../../lib/orchestrator/opencode-runtime-check";
import { findConfiguredRoot } from "../../lib/orchestrator/root-context";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import { validateClaudePluginAssets } from "../../lib/package-paths";
import { syncCompanionFiles } from "../../tools/setup";
import {
  collectCompanionMarketplaceStaleness,
  CompanionMarketplaceError,
  generateCompanionMarketplace,
} from "../../tools/setup/companion-marketplace";
import { registerMateClaudePluginGlobally } from "../../tools/setup/global-claude-registration";
import { registerMateOpenCodePluginGlobally } from "../../tools/setup/global-opencode-registration";
import {
  planWorkingRepoClaudeSettings,
  syncWorkingRepoClaudeSettings,
} from "../../tools/setup/providers/claude";
import { runIndexCapCommand } from "./cap/index-cmd";

export interface SyncCommandDeps {
  cwd?: string;
  globalConfigStore?: GlobalConfigStore;
  syncCompanionGit?: typeof syncCompanionGit;
  syncCompanionFiles?: typeof syncCompanionFiles;
  generateCompanionMarketplace?: typeof generateCompanionMarketplace;
  syncWorkingRepoClaudeSettings?: typeof syncWorkingRepoClaudeSettings;
  refreshCapabilityIndex?: () => Promise<void>;
  validateClaudePluginAssets?: () => void;
  collectOpenCodeRuntimeProblems?: typeof collectOpenCodeRuntimeProblems;
  registerMateClaudePluginGlobally?: typeof registerMateClaudePluginGlobally;
  registerMateOpenCodePluginGlobally?: typeof registerMateOpenCodePluginGlobally;
}

interface SyncOptions {
  check: boolean;
  noGit: boolean;
}

function fail(message: string): void {
  console.error(`${FRAMEWORK_NAME}: ${message}`);
  process.exitCode = 1;
}

function parseSyncArgs(argv: string[]): SyncOptions | null {
  const options: SyncOptions = { check: false, noGit: false };
  for (const arg of argv) {
    if (arg === "--check") options.check = true;
    else if (arg === "--no-git") options.noGit = true;
    else {
      fail(`unknown sync argument: ${arg}`);
      return null;
    }
  }
  return options;
}

async function loadRootConfig(rootPath: string): Promise<FrameworkConfig> {
  const configPath = path.join(rootPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  return mergeWithDefaults(await new ConfigStore(configPath).load());
}

/**
 * Companion-side repair validations moved out of launch preflight: missing
 * bundled plugin assets and invalid OpenCode package references are reported
 * here (and by doctor) instead of blocking sessions.
 */
async function collectCompanionRepairs(
  companionPath: string,
  config: FrameworkConfig,
  deps: SyncCommandDeps,
): Promise<string[]> {
  const problems: string[] = [];

  try {
    (deps.validateClaudePluginAssets ?? validateClaudePluginAssets)();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`${message}. Repair it: reinstall ${FRAMEWORK_NAME}.`);
  }

  if ((config.allowedAgents ?? []).includes("opencode")) {
    const collect = deps.collectOpenCodeRuntimeProblems ?? collectOpenCodeRuntimeProblems;
    problems.push(...(await collect(companionPath, config.capabilities ?? [])));
  }

  return problems;
}

/** Companion-type sync body, shared by companion roots, hub members, and working sync. */
async function syncCompanionRuntime(
  companionPath: string,
  config: FrameworkConfig,
  deps: SyncCommandDeps,
  repoPath?: string,
): Promise<string[]> {
  // Keep the global plugin registrations current (stable ~/.mate path,
  // re-pointed after package updates) on every sync.
  await (deps.registerMateClaudePluginGlobally ?? registerMateClaudePluginGlobally)();
  if ((config.allowedAgents ?? []).includes("opencode")) {
    await (deps.registerMateOpenCodePluginGlobally ?? registerMateOpenCodePluginGlobally)();
  }
  await (deps.syncCompanionFiles ?? syncCompanionFiles)(companionPath, config, repoPath);
  try {
    await (deps.generateCompanionMarketplace ?? generateCompanionMarketplace)(companionPath);
  } catch (error) {
    if (error instanceof CompanionMarketplaceError) return error.problems;
    throw error;
  }
  return collectCompanionRepairs(companionPath, config, deps);
}

async function runWorkingSync(
  rootPath: string,
  options: SyncOptions,
  deps: SyncCommandDeps,
): Promise<void> {
  const globalConfigStore = deps.globalConfigStore ?? new GlobalConfigStore();
  const resolution = await new CompanionResolver(globalConfigStore).resolveWithDiagnostics(
    rootPath,
    { logFailures: true },
  );

  if (resolution.ambiguousMatches.length > 1) {
    fail(
      [
        "multiple companions are linked to this repository:",
        ...resolution.ambiguousMatches.map((match) => `  ${match.companionPath}`),
        `Pin one with \`${FRAMEWORK_NAME} companion select <id>\`.`,
      ].join("\n"),
    );
    return;
  }
  if (!resolution.match) {
    fail(
      `this repository is not linked to a companion. Run \`${FRAMEWORK_NAME} companion link\` first.`,
    );
    return;
  }

  const companionPath = resolution.match.companionPath;
  const config = await loadRootConfig(companionPath);

  if (options.check) {
    const problems: string[] = [];

    const plan = await planWorkingRepoClaudeSettings(
      rootPath,
      companionPath,
      config,
      globalConfigStore,
    );
    if (plan.staleManagedKeys.length > 0) {
      problems.push(
        `stale managed settings keys in ${plan.settingsPath}: ${plan.staleManagedKeys.join(", ")}`,
      );
    }

    try {
      const staleScaffold = await collectCompanionMarketplaceStaleness(companionPath);
      problems.push(
        ...staleScaffold.map((file) => `stale companion marketplace scaffold: ${file}`),
      );
    } catch (error) {
      if (!(error instanceof CompanionMarketplaceError)) throw error;
      problems.push(...error.problems);
    }

    if (problems.length > 0) {
      fail(["materialized configuration is stale:", ...problems.map((p) => `  ${p}`)].join("\n"));
    }
    return;
  }

  if (config.git === "auto" && !options.noGit) {
    await (deps.syncCompanionGit ?? syncCompanionGit)(companionPath, rootPath);
  }

  const repairs = await syncCompanionRuntime(companionPath, config, deps, rootPath);
  await (deps.syncWorkingRepoClaudeSettings ?? syncWorkingRepoClaudeSettings)(
    rootPath,
    companionPath,
    config,
    globalConfigStore,
  );
  await (deps.refreshCapabilityIndex ?? (() => runIndexCapCommand([])))();

  if (repairs.length > 0) {
    fail(["companion needs repair:", ...repairs.map((p) => `  ${p}`)].join("\n"));
  }
}

async function runCompanionSync(
  rootPath: string,
  options: SyncOptions,
  deps: SyncCommandDeps,
): Promise<string[]> {
  const config = await loadRootConfig(rootPath);

  if (options.check) {
    try {
      const staleScaffold = await collectCompanionMarketplaceStaleness(rootPath);
      return staleScaffold.map((file) => `stale companion marketplace scaffold: ${file}`);
    } catch (error) {
      if (!(error instanceof CompanionMarketplaceError)) throw error;
      return error.problems;
    }
  }

  return syncCompanionRuntime(rootPath, config, deps);
}

async function runHubSync(
  rootPath: string,
  options: SyncOptions,
  deps: SyncCommandDeps,
): Promise<void> {
  const config = await loadRootConfig(rootPath);
  const members = config.hub?.companions ?? [];
  if (members.length === 0) {
    console.log(`${FRAMEWORK_NAME}: hub has no registered members; nothing to sync.`);
    return;
  }

  let failed = false;
  for (const member of members) {
    const memberPath = path.resolve(rootPath, member.path);
    try {
      const problems = await runCompanionSync(memberPath, options, deps);
      if (problems.length > 0) {
        failed = true;
        console.log(`${member.id}: needs repair`);
        for (const problem of problems) console.error(`  ${problem}`);
      } else {
        console.log(`${member.id}: ${options.check ? "fresh" : "synced"}`);
      }
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${member.id}: failed`);
      console.error(`  ${message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

/**
 * @command mate sync [--check] [--no-git]
 * @description Type-aware synchronization replacing pre-launch sync: `working`
 * pulls companion git (git mode `auto`), materializes Claude session
 * configuration into the working repo, and refreshes the capability index;
 * `companion` refreshes runtime assets and regenerates the plugin-marketplace
 * scaffold; `hub` fans out over registered members.
 * @flags
 * - `--check` — report staleness without writing; exits non-zero when stale.
 * - `--no-git` — skip the companion git pull for working-type sync.
 */
export async function runSyncCommand(argv: string[], deps: SyncCommandDeps = {}): Promise<void> {
  const options = parseSyncArgs(argv);
  if (!options) return;

  const cwd = path.resolve(deps.cwd ?? process.cwd());
  const rootPath = await findConfiguredRoot(cwd);
  if (!rootPath) {
    fail(
      `No Mate root found for ${cwd}. Run \`${FRAMEWORK_NAME} companion link\` in a working repository or \`${FRAMEWORK_NAME} companion setup\` in a companion.`,
    );
    return;
  }

  const config = await loadRootConfig(rootPath);
  if (config.type === "hub") {
    await runHubSync(rootPath, options, deps);
    return;
  }
  if (config.type === "working") {
    await runWorkingSync(rootPath, options, deps);
    return;
  }

  const problems = await runCompanionSync(rootPath, options, deps);
  if (problems.length > 0) {
    fail(
      [
        options.check ? "materialized configuration is stale:" : "companion needs repair:",
        ...problems.map((p) => `  ${p}`),
      ].join("\n"),
    );
  }
}
