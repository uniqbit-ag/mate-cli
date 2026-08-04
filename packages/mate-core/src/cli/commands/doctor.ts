import { execFileSync } from "node:child_process";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { getActiveDistribution } from "../../distribution";
import { checkEngineRequirement } from "../../lib/orchestrator/engine-guard";
import type { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { pathIsDirectory } from "../../lib/orchestrator/repo-local-registry";
import { resolveRootContext, type RootContext } from "../../lib/orchestrator/root-context";
import type { CapabilityConfig, FrameworkConfig, HubMember } from "../../lib/orchestrator/types";
import { getRequiredPluginDrift } from "../../tools/setup/policy";
import { resolveCommandOnPath } from "../../tools/setup/utils";
import { printSection, renderKeyValueTable, renderTable } from "./status";

interface DoctorDeps {
  globalConfigStore?: GlobalConfigStore;
  cwd?: string;
  pathValue?: string;
  /** Returns a member checkout's HEAD commit, or null when unreadable. */
  gitHead?: (memberPath: string) => string | null;
}

export type DoctorKind = "core" | "working" | "companion" | "hub";

export interface DoctorToolInstallation {
  tool: string;
  source: string;
  status: "ok" | "missing";
  path: string | null;
}

export interface DoctorHubMember {
  id: string;
  source: "git" | "local";
  path: string;
  exists: boolean;
  commitStatus: "ok" | "drifted" | "missing" | "unknown";
  materializedCommit: string | null;
  actualCommit: string | null;
}

export interface DoctorReport {
  kind: DoctorKind;
  cwd: string;
  companionPath: string | null;
  repositoryId: string | null;
  multipleCompanions: Array<{ companionPath: string; repositoryId: string }>;
  policy?: { allowedAgents: string[] };
  policyError?: string;
  capabilities?: string[];
  toolInstallations?: DoctorToolInstallation[];
  requiredPluginDrift?: Array<{ pluginId: string; kind: string; reason: string }>;
  engineRequirement?: { range: string; ok: boolean; detail: string };
  hub?: { members: DoctorHubMember[] };
  resolutionFailures: Array<{ companionPath: string; message: string }>;
}

interface ToolCheck {
  name: string;
  command: string;
  source: string;
}

/** Doctor's view of the shared root kind: registry/env resolution means cwd is a working repo. */
function doctorKind(root: RootContext): DoctorKind {
  if (root.kind === "core") return "core";
  if (root.kind === "hub") return "hub";
  if (root.origin === "env" || root.origin === "registry") return "working";
  return root.kind;
}

function defaultGitHead(memberPath: string): string | null {
  try {
    return execFileSync("git", ["-C", memberPath, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
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
    checks.push({ name: "headroom", command: "headroom", source: "capability" });
  }
  if (selectedCapabilities.has("rtk")) {
    checks.push({ name: "rtk", command: "rtk", source: "capability" });
  }
  if (selectedCapabilities.has("graphify")) {
    checks.push({ name: "graphify", command: "graphify", source: "capability" });
  }

  return checks;
}

function collectToolInstallations(
  config: FrameworkConfig,
  pathValue: string,
): DoctorToolInstallation[] {
  return getSelectedToolChecks(config).map((check) => {
    const resolved = resolveCommandOnPath(check.command, pathValue);
    return {
      tool: check.name,
      source: check.source,
      status: resolved ? "ok" : "missing",
      path: resolved ?? null,
    };
  });
}

// Only the engines key matching the running distribution produces a
// diagnostic; foreign distribution keys are ignored entirely.
function collectEngineRequirement(
  config: FrameworkConfig,
): DoctorReport["engineRequirement"] | undefined {
  const range = config.engines?.[FRAMEWORK_NAME];
  if (!range) return undefined;
  const currentVersion = getActiveDistribution().config.version;
  const result = checkEngineRequirement(config, FRAMEWORK_NAME, currentVersion);
  return {
    range,
    ok: result.ok,
    detail: result.ok
      ? `engines.${FRAMEWORK_NAME}: satisfied (requires ${range}, running ${currentVersion})`
      : `engines.${FRAMEWORK_NAME}: ${result.reason}`,
  };
}

async function collectHubMember(
  hubPath: string,
  member: HubMember,
  gitHead: (memberPath: string) => string | null,
): Promise<DoctorHubMember> {
  const memberPath = path.resolve(hubPath, member.path);
  const base = {
    id: member.id,
    source: member.source.kind,
    path: memberPath,
    materializedCommit: member.materializedCommit ?? null,
  };
  if (!(await pathIsDirectory(memberPath))) {
    return { ...base, exists: false, commitStatus: "missing", actualCommit: null };
  }
  if (!member.materializedCommit) {
    return { ...base, exists: true, commitStatus: "ok", actualCommit: null };
  }
  const actualCommit = gitHead(memberPath);
  return {
    ...base,
    exists: true,
    commitStatus:
      actualCommit === null
        ? "unknown"
        : actualCommit === member.materializedCommit
          ? "ok"
          : "drifted",
    actualCommit,
  };
}

async function collectWorkingSections(
  report: DoctorReport,
  root: RootContext,
  pathValue: string,
): Promise<void> {
  if (!root.rootPath || !root.repositoryId || !root.config) {
    report.policyError = "No repository ID was provided for the resolved companion.";
    return;
  }

  report.policy = { allowedAgents: root.config.allowedAgents ?? [] };
  collectConfiguredRootSections(report, root.config, pathValue);
}

function collectConfiguredRootSections(
  report: DoctorReport,
  config: FrameworkConfig,
  pathValue: string,
): void {
  report.capabilities = (config.capabilities ?? []).map((capability) => capability.name);
  report.toolInstallations = collectToolInstallations(config, pathValue);
  report.requiredPluginDrift = getRequiredPluginDrift(config);
  report.engineRequirement = collectEngineRequirement(config);
}

export async function collectDoctorReport(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const cwd = path.resolve(deps.cwd ?? process.cwd());
  const pathValue = deps.pathValue ?? process.env.PATH ?? "";
  const gitHead = deps.gitHead ?? defaultGitHead;
  const root = await resolveRootContext(cwd, deps);
  const kind = doctorKind(root);

  const report: DoctorReport = {
    kind,
    cwd,
    companionPath: root.rootPath ?? null,
    repositoryId: root.repositoryId ?? null,
    multipleCompanions:
      root.resolution.ambiguousMatches.length > 1 ? root.resolution.ambiguousMatches : [],
    resolutionFailures: root.resolution.failures,
  };

  if (kind === "working") {
    await collectWorkingSections(report, root, pathValue);
  } else if (kind === "companion" && root.config) {
    collectConfiguredRootSections(report, root.config, pathValue);
  } else if (kind === "hub" && root.rootPath && root.config) {
    report.hub = {
      members: await Promise.all(
        (root.config.hub?.companions ?? []).map((member) =>
          collectHubMember(root.rootPath!, member, gitHead),
        ),
      ),
    };
    report.requiredPluginDrift = getRequiredPluginDrift(root.config);
    report.engineRequirement = collectEngineRequirement(root.config);
  }

  return report;
}

function renderList(items: string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function renderCapabilities(capabilities: string[]): string {
  return capabilities.length > 0
    ? renderTable(
        ["Capability"],
        capabilities.map((capability) => [capability]),
      )
    : "No capabilities configured.";
}

function renderToolInstallations(installations: DoctorToolInstallation[]): string {
  if (installations.length === 0) {
    return "No selected capabilities or package managers require command checks.";
  }
  return renderTable(
    ["Tool", "Source", "Status", "Path"],
    installations.map((item) => [item.tool, item.source, item.status, item.path ?? ""]),
  );
}

function renderHubMembers(members: DoctorHubMember[]): string {
  if (members.length === 0) return "No hub members configured.";
  return renderTable(
    ["Member", "Source", "Path", "Exists", "Commit"],
    members.map((member) => [
      member.id,
      member.source,
      member.path,
      member.exists ? "yes" : "no",
      member.commitStatus,
    ]),
  );
}

function renderHumanReport(report: DoctorReport): void {
  console.log("Mate Doctor");
  console.log("");
  printSection(
    "Context",
    renderKeyValueTable([
      ["State", report.kind],
      ["Current Working Directory", report.cwd],
      ["Companion Path", report.companionPath ?? "none"],
      ["Repository ID", report.repositoryId ?? "none"],
    ]),
  );

  if (report.multipleCompanions.length > 1) {
    printSection(
      "Multiple Companions",
      [
        "This working repo is linked from multiple companions. The Companion Path above",
        "was picked arbitrarily (first registered); commands that don't prompt for a",
        "choice will use it too. Set MATE_ARTIFACT_PATH (and MATE_REPO_ID) to pin one.",
        "",
        renderTable(
          ["Companion Path", "Repository ID"],
          report.multipleCompanions.map((match) => [match.companionPath, match.repositoryId]),
        ),
      ].join("\n"),
    );
  }

  if (report.policy) {
    printSection(
      "Allowed Agents",
      renderList(report.policy.allowedAgents, "No allowed agents configured."),
    );
  }
  if (report.policyError) printSection("Policy", report.policyError);
  if (report.capabilities) printSection("Capabilities", renderCapabilities(report.capabilities));
  if (report.toolInstallations) {
    printSection("Tool Installations", renderToolInstallations(report.toolInstallations));
  }
  if (report.hub) printSection("Hub Members", renderHubMembers(report.hub.members));
  // Companions with no drift produce no section at all: required plugins are
  // silent when healthy.
  if (report.requiredPluginDrift && report.requiredPluginDrift.length > 0) {
    printSection(
      "Required Plugin Drift",
      renderTable(
        ["Plugin", "Kind", "Issue"],
        report.requiredPluginDrift.map((entry) => [entry.pluginId, entry.kind, entry.reason]),
      ),
    );
  }
  if (report.engineRequirement) {
    printSection("Version Requirement", report.engineRequirement.detail);
  }

  printSection(
    "Resolution Failures",
    report.resolutionFailures.length > 0
      ? renderTable(
          ["Companion Path", "Error"],
          report.resolutionFailures.map((failure) => [failure.companionPath, failure.message]),
        )
      : "No companion resolution failures encountered.",
  );
}

/**
 * @command mate doctor
 * @description Reports the current directory's root kind — `working` (linked
 * working repository), `companion`, `hub`, or `core` (not linked) — with
 * kind-specific diagnostics: policy and capabilities for working repos,
 * capabilities and tool checks for companions, member health for hubs.
 * `--json` emits the same report as one JSON document.
 */
export async function runDoctorCommand(argv: string[] = [], deps: DoctorDeps = {}): Promise<void> {
  const report = await collectDoctorReport(deps);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  renderHumanReport(report);
}
