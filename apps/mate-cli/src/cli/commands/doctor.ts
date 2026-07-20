import fs from "node:fs/promises";
import path from "node:path";

import packageJson from "../../../package.json";
import { frameworkConfig } from "../../framework";
import { CompanionResolver } from "../../lib/orchestrator/companion-resolver";
import { CompanionStore, resolvePolicyFromConfig } from "../../lib/orchestrator/companion-store";
import { ConfigStore } from "../../lib/orchestrator/config-store";
import { checkMateEngineRequirement } from "../../lib/orchestrator/engine-guard";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { migrateConfigDir } from "../../lib/orchestrator/migration";
import { findRepoLocalLinkedRepository } from "../../lib/orchestrator/repo-local-registry";
import type { CapabilityConfig, FrameworkConfig } from "../../lib/orchestrator/types";
import { WorkingRepoStore } from "../../lib/orchestrator/working-repo-store";
import { resolveCommandOnPath } from "../../tools/setup/utils";
import { printSection, renderKeyValueTable, renderTable } from "./status";

interface DoctorDeps {
  globalConfigStore?: GlobalConfigStore;
  cwd?: string;
  pathValue?: string;
}

interface CompanionStores {
  configStore: ConfigStore;
  workingRepoStore: WorkingRepoStore;
}

interface ToolCheck {
  name: string;
  command: string;
  source: string;
}

function storesForCompanion(companionPath: string): CompanionStores {
  const configDir = path.join(companionPath, `.${frameworkConfig.name}`, "config");
  return {
    configStore: new ConfigStore(path.join(configDir, "framework.yaml")),
    workingRepoStore: new WorkingRepoStore(path.join(configDir, "registry.yaml")),
  };
}

async function hasLocalCompanionConfig(cwd: string): Promise<boolean> {
  const localDir = path.join(cwd, `.${frameworkConfig.name}`);
  const localLegacyDirs = frameworkConfig.legacyNames.map((name) => path.join(cwd, `.${name}`));
  await migrateConfigDir(localDir, localLegacyDirs);

  try {
    await fs.access(path.join(localDir, "config", "framework.yaml"));
    return true;
  } catch {
    return false;
  }
}

function renderList(items: string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function renderEngineRequirement(config: FrameworkConfig, currentVersion: string): string {
  const range = config.engines?.mate;
  const result = checkMateEngineRequirement(config, currentVersion);
  return result.ok
    ? `engines.mate: satisfied (requires ${range}, running ${currentVersion})`
    : `engines.mate: ${result.reason}`;
}

function printEngineRequirement(config: FrameworkConfig): void {
  if (!config.engines?.mate) return;
  printSection("Version Requirement", renderEngineRequirement(config, packageJson.version));
}

function renderCapabilities(capabilities: CapabilityConfig[]): string {
  return capabilities.length > 0
    ? renderTable(
        ["Capability"],
        capabilities.map((capability) => [capability.name]),
      )
    : "No capabilities configured.";
}

function getSelectedToolChecks(config: {
  capabilities?: CapabilityConfig[];
  packageManagers?: string[];
}): ToolCheck[] {
  const selectedCapabilities = new Set(
    (config.capabilities ?? []).map((capability) => capability.name),
  );
  const selectedPackageManagers = new Set(config.packageManagers ?? []);
  const checks: ToolCheck[] = [];

  if (selectedPackageManagers.has("bun")) {
    checks.push({ name: "bun", command: "bun", source: "package manager" });
  }
  if (selectedPackageManagers.has("uv")) {
    checks.push({ name: "uv", command: "uv", source: "package manager" });
  }
  if (selectedCapabilities.has("openspec")) {
    checks.push({ name: "openspec", command: "openspec", source: "capability" });
  }
  if (selectedCapabilities.has("tokensave")) {
    checks.push({ name: "tokensave", command: "tokensave", source: "capability" });
  }
  if (selectedCapabilities.has("headroom")) {
    checks.push(
      { name: "headroom", command: "headroom", source: "capability" },
      { name: "rtk", command: "rtk", source: "headroom dependency" },
    );
  }
  if (selectedCapabilities.has("graphify")) {
    checks.push({ name: "graphify", command: "graphify", source: "capability" });
  }

  return checks;
}

function renderToolInstallations(
  config: {
    capabilities?: CapabilityConfig[];
    packageManagers?: string[];
  },
  pathValue: string,
): string {
  const checks = getSelectedToolChecks(config);
  if (checks.length === 0) {
    return "No selected capabilities or package managers require command checks.";
  }

  return renderTable(
    ["Tool", "Source", "Status", "Path"],
    checks.map((check) => {
      const resolved = resolveCommandOnPath(check.command, pathValue);
      return [check.name, check.source, resolved ? "ok" : "missing", resolved ?? ""];
    }),
  );
}

/**
 * @command mate doctor
 * @description Reports whether the current directory resolves as a linked
 * working repository, a companion repository, or neither. For linked working
 * repositories it also prints the effective policy and enabled capabilities.
 */
export async function runDoctorCommand(_argv: string[] = [], deps: DoctorDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const pathValue = deps.pathValue ?? process.env.PATH ?? "";
  const envCompanionPath = process.env.MATE_ARTIFACT_PATH;
  const globalConfigStore = deps.globalConfigStore ?? new GlobalConfigStore();
  const resolver = new CompanionResolver(globalConfigStore);

  let state: "linked-working-repository" | "companion-repository" | "not-linked";
  let companionPath = "";
  let repositoryId = "";
  let repository = await findRepoLocalLinkedRepository(cwd);
  const resolution = envCompanionPath
    ? { match: null, failures: [], ambiguousMatches: [] }
    : await resolver.resolveWithDiagnostics(cwd);

  if (envCompanionPath) {
    state = "linked-working-repository";
    companionPath = path.resolve(envCompanionPath);
    repositoryId = process.env.MATE_REPO_ID ?? repository?.id ?? "";
  } else if (resolution.match) {
    state = "linked-working-repository";
    companionPath = resolution.match.companionPath;
    repositoryId = repository?.id ?? resolution.match.repositoryId;
  } else if (await hasLocalCompanionConfig(cwd)) {
    state = "companion-repository";
    companionPath = cwd;
  } else {
    state = "not-linked";
  }

  console.log("Mate Doctor");
  console.log("");
  printSection(
    "Context",
    renderKeyValueTable([
      ["State", state],
      ["Current Working Directory", cwd],
      ["Companion Path", companionPath || "none"],
      ["Repository ID", repositoryId || "none"],
    ]),
  );

  if (resolution.ambiguousMatches.length > 1) {
    printSection(
      "Multiple Companions",
      [
        "This working repo is linked from multiple companions. The Companion Path above",
        "was picked arbitrarily (first registered); commands that don't prompt for a",
        "choice will use it too. Set MATE_ARTIFACT_PATH (and MATE_REPO_ID) to pin one.",
        "",
        renderTable(
          ["Companion Path", "Repository ID"],
          resolution.ambiguousMatches.map((match) => [match.companionPath, match.repositoryId]),
        ),
      ].join("\n"),
    );
  }

  if (state === "linked-working-repository" && companionPath && repositoryId) {
    const { configStore, workingRepoStore } = storesForCompanion(companionPath);
    const config = await configStore.load();
    let resolvedPolicy;

    if (repository) {
      resolvedPolicy = resolvePolicyFromConfig(config, [repository], repository.id);
    } else {
      resolvedPolicy = await new CompanionStore(configStore, workingRepoStore).resolvePolicy(
        repositoryId,
      );
    }

    if (!repository) {
      const working = await workingRepoStore.load();
      repository = working.repos.find((repo) => repo.id === repositoryId) ?? null;
    }

    printSection(
      "Policy",
      renderKeyValueTable([
        ["Profile", repository?.profile ?? "unknown"],
        ["Allowed Agents", resolvedPolicy.allowedAgents.join(", ") || "none"],
      ]),
    );
    printSection(
      "Allowed Agents",
      renderList(resolvedPolicy.allowedAgents, "No allowed agents configured."),
    );
    printSection("Capabilities", renderCapabilities(config.capabilities ?? []));
    printSection("Tool Installations", renderToolInstallations(config, pathValue));
    printEngineRequirement(config);
  } else if (state === "linked-working-repository") {
    printSection("Policy", "No repository ID was provided for the resolved companion.");
  } else if (companionPath) {
    const { configStore } = storesForCompanion(companionPath);
    const config = await configStore.load();
    printSection("Capabilities", renderCapabilities(config.capabilities ?? []));
    printSection("Tool Installations", renderToolInstallations(config, pathValue));
    printEngineRequirement(config);
  }

  printSection(
    "Resolution Failures",
    resolution.failures.length > 0
      ? renderTable(
          ["Companion Path", "Error"],
          resolution.failures.map((failure) => [failure.companionPath, failure.message]),
        )
      : "No companion resolution failures encountered.",
  );
}
