import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { gitEnvironment } from "../../runtime/companion-git";
import { checkoutCommonDir, checkoutRootOf, sameClone } from "../../runtime/git-layout";
import { physicalPath } from "../../runtime/physical-path";
import { otherServingClaudeWrapRoot } from "../../runtime/serving-claude-wrap";
import { readWrapStateSync } from "../../runtime/wrap-state";
import { companionClaudeMdHasOwnText } from "../../runtime/companion-instructions";
import {
  resolveSession,
  sessionRefusalReason,
  type SessionRefusal,
} from "../../runtime/session-resolution";
import { getActiveDistribution } from "../../distribution";
import { hasOpenspecCapability } from "../../lib/orchestrator/capabilities";
import {
  inheritedWrapRuntimes,
  registeredCheckout,
} from "../../lib/orchestrator/checkout-adoption";
import { checkEngineRequirement } from "../../lib/orchestrator/engine-guard";
import type { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { pathIsDirectory } from "../../lib/fs-utils";
import { resolveRootContext, type RootContext } from "../../lib/orchestrator/root-context";
import type { CapabilityConfig, FrameworkConfig, HubMember } from "../../lib/orchestrator/types";
import { locateOpenSpec, type OpenSpecLocation } from "../../lib/openspec-cli";
import { MATE_CLAUDE_PLUGIN_NAME } from "../../lib/package-paths";
import {
  describeUnknownAudience,
  readAudienceSelection,
  resolveAudience,
} from "../../tools/setup/dynamic-plugins/audiences";
import {
  inspectDeclaredPlugins,
  type PluginInspection,
  type PluginVerificationFailure,
} from "../../tools/setup/dynamic-plugins/verify";
import { hydrateDynamicPlugins } from "../../tools/setup/dynamic-plugins/hydrate";
import {
  inspectClaudePluginDirectories,
  type ClaudePluginDirectoryInspection,
} from "../../tools/setup";
import { getRequiredPluginDrift } from "../../tools/setup/policy";
import {
  CLAUDE_PLUGIN_MANIFEST,
  CLAUDE_PLUGIN_MARKETPLACE,
  type ClaudePluginContributionFailure,
  type ClaudePluginDirectoryProblem,
  type ClaudePluginDirectoryReport,
  type ClaudePluginUnpublishedReason,
} from "../../tools/setup/providers/claude-plugin-folders";
import { isMateSessionPrepareHookGroup } from "../../tools/setup/providers/claude-plugin-hooks";
import { resolveCommandOnPath } from "../../tools/setup/utils";
import { writeJsonStdout } from "../write-json-stdout";
import { printSection, renderKeyValueTable, renderTable } from "./status";

interface DoctorDeps {
  globalConfigStore?: GlobalConfigStore;
  cwd?: string;
  pathValue?: string;
  /** Returns a member checkout's HEAD commit, or null when unreadable. */
  gitHead?: (memberPath: string) => string | null;
  inspectPlugins?: (companionPath: string) => Promise<PluginInspection>;
  /** Loads the companion's declared plugins so their Capabilities contribute. */
  hydratePlugins?: (companionPath: string) => Promise<void>;
  inspectClaudePlugins?: (
    companionPath: string,
    config: FrameworkConfig,
  ) => Promise<ClaudePluginDirectoryInspection>;
  /** Environment `MATE_AUDIENCE` is read from; defaults to the process environment. */
  env?: Record<string, string | undefined>;
}

export type DoctorKind = "core" | "working" | "companion" | "hub";

export interface DoctorToolInstallation {
  tool: string;
  source: string;
  status: "ok" | "missing";
  path: string | null;
  /** Set for a tool Mate ships itself, such as the OpenSpec CLI. */
  version?: string;
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
  pluginFailures?: PluginVerificationFailure[];
  /** Present for a companion that declares audiences or has one selected. */
  audiences?: { declared: string[]; active: string | null };
  /** Set when `MATE_AUDIENCE` names an audience the companion does not declare. */
  audienceError?: string;
  /** IDs of the capabilities the verified plugins provide. */
  pluginCapabilities?: string[];
  engineRequirement?: { range: string; ok: boolean; detail: string };
  /** Present when the companion's `openspec/config.yaml` has `rules` keys OpenSpec ignores. */
  openspecRuleWarnings?: Array<{ key: string; message: string }>;
  /** Present when the companion `CLAUDE.md` holds text no Working Repository session receives. */
  companionInstructionWarnings?: Array<{ file: string; message: string }>;
  /**
   * Enabled Capabilities' Claude plugin folders, which load only with `mate claude`; absent when
   * none. `problem` names why `mate claude` leaves a folder out: `not-absolute`,
   * `missing-manifest`, `bundled-mate-plugin` (Mate's own plugin, which every managed launch
   * loads already) or `mate-plugin-name` (its manifest uses Mate's plugin name).
   */
  claudePlugins?: ClaudePluginDirectoryReport[];
  /** Capabilities whose contributions failed, so their Claude plugin folders are unknown; absent when none. */
  claudePluginFailures?: ClaudePluginContributionFailure[];
  hub?: { members: DoctorHubMember[] };
  resolutionFailures: Array<{ companionPath: string; message: string }>;
  /**
   * Set when plain sessions in this folder refuse its projection; Session
   * Resolution's own refusal, so doctor and the sessions cannot disagree.
   */
  projectionRefusal?: SessionRefusal;
  /** Present inside a Git Checkout of a linked clone, or a worktree Git no longer recognizes. */
  checkout?: DoctorCheckout;
}

export interface DoctorCheckout {
  /** The root of the Checkout holding the current directory. */
  root: string;
  /**
   * `registered`: the clone's Registered Checkout. `other`: another Checkout of
   * the clone. `not-recognized`: a linked worktree whose record in the shared
   * Git folder names another folder, which `git worktree repair` fixes.
   */
  role: "registered" | "other" | "not-recognized";
  repositoryId: string | null;
  registeredCheckout: string | null;
  /** The Checkout whose Claude wrap serves this one. */
  servingClaudeWrap: string;
  /** Set when plain `claude` sessions here start without Mate's session prepare. */
  servingWrapWarning?: string;
}

interface ToolCheck {
  name: string;
  command: string;
  source: string;
  /** Locates a tool Mate ships instead of looking it up on PATH. */
  bundled?: () => OpenSpecLocation;
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
      env: gitEnvironment(),
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
    checks.push({
      name: "openspec",
      command: "openspec",
      source: "capability",
      bundled: locateOpenSpec,
    });
  }
  if (selectedCapabilities.has("tokensave")) {
    checks.push({ name: "tokensave", command: "tokensave", source: "capability" });
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
    if (check.bundled) {
      const source = `${check.source}, bundled with ${FRAMEWORK_NAME}`;
      const location = check.bundled();
      if ("missing" in location) {
        return { tool: check.name, source, status: "missing", path: null };
      }
      // An unreadable manifest only loses the version; the CLI itself resolved.
      return {
        tool: check.name,
        source,
        status: "ok",
        path: location.bin,
        ...(location.version ? { version: location.version } : {}),
      };
    }
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

function collectAudiences(
  report: DoctorReport,
  config: FrameworkConfig,
  env: Record<string, string | undefined>,
): void {
  const declared = Object.keys(config.audiences ?? {});
  const requested = readAudienceSelection(env);
  if (declared.length === 0 && requested === null) return;
  const resolution = resolveAudience(config, requested);
  report.audiences = { declared, active: resolution.ok ? resolution.active : null };
  if (!resolution.ok) report.audienceError = describeUnknownAudience(resolution);
}

/** Artifact IDs of OpenSpec's built-in `spec-driven` schema. */
const BUILT_IN_OPENSPEC_ARTIFACTS = ["proposal", "specs", "design", "tasks"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Built-in IDs plus every `artifacts[].id` from a `schema.yaml` under the companion's `openspec/schemas/`. */
async function knownOpenSpecArtifactIds(companionPath: string): Promise<Set<string>> {
  const schemasDir = path.join(companionPath, "openspec", "schemas");
  let schemaNames: string[] = [];
  try {
    schemaNames = await fs.readdir(schemasDir);
  } catch {
    /* no companion schemas */
  }
  const schemaIds = await Promise.all(
    schemaNames.map(async (name) => {
      try {
        const schema = asRecord(
          parseYaml(await fs.readFile(path.join(schemasDir, name, "schema.yaml"), "utf8")),
        );
        const artifacts: unknown[] = Array.isArray(schema?.artifacts) ? schema.artifacts : [];
        return artifacts.flatMap((artifact) => {
          const id = asRecord(artifact)?.id;
          return typeof id === "string" ? [id] : [];
        });
      } catch {
        return []; // not a readable schema
      }
    }),
  );
  return new Set([...BUILT_IN_OPENSPEC_ARTIFACTS, ...schemaIds.flat()]);
}

/**
 * OpenSpec ignores a `rules` key that names no artifact, warning only on stderr
 * of the command that reads it. Read-only; a missing or unparseable config is silent.
 */
async function collectOpenSpecRuleWarnings(
  companionPath: string,
): Promise<NonNullable<DoctorReport["openspecRuleWarnings"]>> {
  let rules: Record<string, unknown> | undefined;
  try {
    const config = parseYaml(
      await fs.readFile(path.join(companionPath, "openspec", "config.yaml"), "utf8"),
    );
    rules = asRecord(asRecord(config)?.rules);
  } catch {
    return [];
  }
  if (!rules) return [];

  const known = await knownOpenSpecArtifactIds(companionPath);
  return Object.keys(rules)
    .filter((key) => !known.has(key))
    .map((key) => ({
      key,
      message: `rules.${key} matches no OpenSpec artifact and is ignored; put workflow guidance in operations.apply.guidance or operations.archive.guidance`,
    }));
}

function collectCompanionInstructionWarnings(
  companionPath: string,
): NonNullable<DoctorReport["companionInstructionWarnings"]> {
  if (!companionClaudeMdHasOwnText(companionPath)) return [];
  const file = path.join(companionPath, "CLAUDE.md");
  return [
    {
      file,
      message: `${file} holds text besides @AGENTS.md and Mate-managed blocks. That text does not reach Working Repository sessions, only sessions started in the companion. Move rules meant for every session into ${path.join(companionPath, "AGENTS.md")}.`,
    },
  ];
}

/** The Checkout's own wraps, or those Adoption would give it (design Decision 8). */
async function wrappedForClaude(
  companionPath: string,
  repository: { id: string; path: string },
): Promise<boolean> {
  return (
    readWrapStateSync(repository.path).runtimes.has("claude") ||
    (await inheritedWrapRuntimes(companionPath, repository)).includes("claude")
  );
}

function carriesPrepareHook(checkoutRoot: string): boolean {
  return readWrapStateSync(checkoutRoot).carriedClaudeHookGroups.some(
    isMateSessionPrepareHookGroup,
  );
}

/**
 * The Checkout section (design Decision 15): how the Checkout holding `cwd`
 * relates to its linked clone, and whether plain `claude` sessions there
 * still reach a session-prepare hook.
 */
async function collectCheckout(
  cwd: string,
  report: DoctorReport,
): Promise<DoctorCheckout | undefined> {
  const found = checkoutRootOf(cwd);
  if (!found) return undefined;
  const { root } = found;
  const otherServing = otherServingClaudeWrapRoot(root);
  if (found.layout.kind === "linked" && checkoutCommonDir(root) === null) {
    return {
      root,
      role: "not-recognized",
      repositoryId: null,
      registeredCheckout: null,
      servingClaudeWrap: root,
    };
  }
  const { companionPath, repositoryId } = report;
  if (!companionPath || !repositoryId) return undefined;
  const registered = await registeredCheckout(companionPath, repositoryId);
  if (!registered || !(physicalPath(registered) === root || sameClone(registered, root))) {
    return undefined;
  }
  const checkout: DoctorCheckout = {
    root,
    role: physicalPath(registered) === root ? "registered" : "other",
    repositoryId,
    registeredCheckout: registered,
    servingClaudeWrap: otherServing ?? root,
  };
  if (
    otherServing &&
    (await wrappedForClaude(companionPath, { id: repositoryId, path: root })) &&
    !carriesPrepareHook(otherServing) &&
    !carriesPrepareHook(root)
  ) {
    const settings = path.join(otherServing, ".claude", "settings.local.json");
    checkout.servingWrapWarning = `Plain \`claude\` sessions in ${root} start without Mate: Claude Code reads its hooks from ${settings}, which carries no ${FRAMEWORK_NAME} session-prepare hook. Run \`${FRAMEWORK_NAME} wrap\` here or in ${otherServing}.`;
  }
  return checkout;
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

  /** What a plain session here would get, so the launch environment doctor runs under is ignored. */
  const session = resolveSession({}, cwd, { globalConfigPath: deps.globalConfigStore?.configPath });
  if (session.kind === "none" && session.refusal) report.projectionRefusal = session.refusal;

  const checkout = await collectCheckout(cwd, report);
  if (checkout) report.checkout = checkout;

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

  const env = deps.env ?? process.env;
  if (root.rootPath && root.config && kind !== "hub") {
    collectAudiences(report, root.config, env);
  }

  if (
    root.rootPath &&
    (kind === "working" || kind === "companion") &&
    hasOpenspecCapability(root.config?.capabilities)
  ) {
    const warnings = await collectOpenSpecRuleWarnings(root.rootPath);
    if (warnings.length > 0) report.openspecRuleWarnings = warnings;
  }

  if (root.rootPath && (kind === "working" || kind === "companion")) {
    const warnings = collectCompanionInstructionWarnings(root.rootPath);
    if (warnings.length > 0) report.companionInstructionWarnings = warnings;
  }

  if (root.rootPath && root.config && (kind === "working" || kind === "companion")) {
    /** Doctor reports plugin failures below; hydration supplies their contributions. */
    const hydrate =
      deps.hydratePlugins ??
      ((companionPath) => hydrateDynamicPlugins({ companionPath, env, warn: () => {} }));
    await hydrate(root.rootPath);
    const inspectClaudePlugins = deps.inspectClaudePlugins ?? inspectClaudePluginDirectories;
    const inspection = await inspectClaudePlugins(root.rootPath, root.config);
    if (inspection.plugins.length > 0) report.claudePlugins = inspection.plugins;
    if (inspection.failures.length > 0) report.claudePluginFailures = inspection.failures;
  }

  if (root.rootPath && root.config) {
    const inspect =
      deps.inspectPlugins ?? ((companionPath) => inspectDeclaredPlugins(companionPath, { env }));
    const inspection = await inspect(root.rootPath);
    report.pluginFailures = inspection.failures;
    report.pluginCapabilities = inspection.capabilities;
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
    installations.map((item) => [
      item.version ? `${item.tool} ${item.version}` : item.tool,
      item.source,
      item.status,
      item.path ?? "",
    ]),
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

/** The Status column's text for each reason a folder is left out. */
const CLAUDE_PLUGIN_PROBLEM_STATUS: Record<ClaudePluginDirectoryProblem, string> = {
  "not-absolute": "not an absolute path",
  "bundled-mate-plugin": "Mate's bundled plugin, already loaded",
  "missing-manifest": `missing ${CLAUDE_PLUGIN_MANIFEST}`,
  "mate-plugin-name": `uses Mate's plugin name ${MATE_CLAUDE_PLUGIN_NAME}`,
};

function claudePluginStatus(plugin: ClaudePluginDirectoryReport): string {
  return plugin.problem ? CLAUDE_PLUGIN_PROBLEM_STATUS[plugin.problem] : "present";
}

/** The Plain Sessions column's text for each reason a loadable folder is not published. */
const CLAUDE_PLUGIN_UNPUBLISHED_STATUS: Record<ClaudePluginUnpublishedReason, string> = {
  "foreign-marketplace": `no: ${CLAUDE_PLUGIN_MARKETPLACE} is not Mate's and does not list it`,
  "invalid-marketplace-name": "no: its name cannot form a marketplace name",
  "name-conflict": "no: its marketplace name is already in use",
  "missing-marketplace": `no: ${CLAUDE_PLUGIN_MARKETPLACE} could not be written`,
};

function claudePluginPlainSessions(plugin: ClaudePluginDirectoryReport): string {
  if (plugin.marketplace) return `marketplace ${plugin.marketplace}`;
  if (plugin.unpublishedReason) return CLAUDE_PLUGIN_UNPUBLISHED_STATUS[plugin.unpublishedReason];
  return "no";
}

/** A table for each list present, then a note on where plain sessions load them. */
function renderClaudePlugins(
  plugins: ClaudePluginDirectoryReport[] | undefined,
  failures: ClaudePluginContributionFailure[] | undefined,
): string {
  const tables: string[] = [];
  if (plugins) {
    tables.push(
      renderTable(
        ["Capability", "Plugin Folder", "Status", "Plain Sessions"],
        plugins.map((plugin) => [
          plugin.capability,
          plugin.path,
          claudePluginStatus(plugin),
          claudePluginPlainSessions(plugin),
        ]),
      ),
    );
  }
  if (failures) {
    tables.push(
      renderTable(
        ["Capability", "Error"],
        failures.map((failure) => [failure.capability, failure.reason]),
      ),
    );
  }
  return [
    ...tables.flatMap((table) => [table, ""]),
    `\`${FRAMEWORK_NAME} claude\` loads every present plugin. Plain \`claude\` sessions load one with a marketplace, and only in a wrapped repository that Claude Code trusts.`,
  ].join("\n");
}

const CHECKOUT_ROLES: Record<DoctorCheckout["role"], (checkout: DoctorCheckout) => string> = {
  registered: ({ repositoryId }) => `the Registered Checkout of ${repositoryId}`,
  other: ({ repositoryId }) => `another Checkout of ${repositoryId}, adopted from its entry`,
  "not-recognized": () => "a linked worktree its clone no longer recognizes",
};

function renderCheckout(checkout: DoctorCheckout): string {
  const lines = [
    renderKeyValueTable([
      ["Checkout", checkout.root],
      ["Role", CHECKOUT_ROLES[checkout.role](checkout)],
      ["Registered Checkout", checkout.registeredCheckout ?? "none"],
      ["Serving Claude Wrap", checkout.servingClaudeWrap],
    ]),
  ];
  if (checkout.role === "not-recognized") {
    lines.push(
      "",
      `Its record in the shared Git folder names another folder, so ${FRAMEWORK_NAME} treats it as no Checkout of the clone. Run \`git worktree repair\` in ${checkout.root}.`,
    );
  }
  if (checkout.servingWrapWarning) lines.push("", `Warning: ${checkout.servingWrapWarning}`);
  return lines.join("\n");
}

function renderProjectionRefusal(refusal: SessionRefusal): string {
  return [
    `This folder's projection names ${refusal.companionPath}, a companion that ${sessionRefusalReason(refusal)}.`,
    "Plain agent sessions here run without Mate: no companion guidance, and no Tool Guard.",
    `Register the companion with \`${FRAMEWORK_NAME} companion link\`, or run \`${FRAMEWORK_NAME} wrap\` from a Checkout it links.`,
  ].join("\n");
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
  if (report.audiences) {
    printSection(
      "Audiences",
      renderKeyValueTable([
        ["Declared", report.audiences.declared.join(", ") || "none"],
        ["Active", report.audiences.active ?? "none"],
      ]),
    );
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
  if (report.pluginFailures && report.pluginFailures.length > 0) {
    printSection(
      "Declared Plugins",
      renderTable(
        ["Plugin", "Issue"],
        report.pluginFailures.map((failure) => [failure.package, failure.reason]),
      ),
    );
  }
  if (report.engineRequirement) {
    printSection("Version Requirement", report.engineRequirement.detail);
  }
  if (report.claudePlugins || report.claudePluginFailures) {
    printSection(
      "Claude Plugins",
      renderClaudePlugins(report.claudePlugins, report.claudePluginFailures),
    );
  }
  if (report.openspecRuleWarnings) {
    printSection(
      "OpenSpec Config",
      renderList(
        report.openspecRuleWarnings.map((warning) => warning.message),
        "",
      ),
    );
  }
  if (report.companionInstructionWarnings) {
    printSection(
      "Companion Instructions",
      renderList(
        report.companionInstructionWarnings.map((warning) => warning.message),
        "",
      ),
    );
  }

  if (report.projectionRefusal) {
    printSection("Refused Projection", renderProjectionRefusal(report.projectionRefusal));
  }
  if (report.checkout) printSection("Checkout", renderCheckout(report.checkout));

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
 * Declared plugins of the effective set (base plus the `MATE_AUDIENCE`
 * audience) are verified strictly (installed, loadable); any failure is named
 * on stderr and exits non-zero, as is an undeclared `MATE_AUDIENCE` or a
 * Capability whose runtime contributions fail to load.
 * `--json` emits the same report as one JSON document.
 */
export async function runDoctorCommand(argv: string[] = [], deps: DoctorDeps = {}): Promise<void> {
  const report = await collectDoctorReport(deps);
  if (argv.includes("--json")) await writeJsonStdout(report);
  else renderHumanReport(report);

  const failures = report.pluginFailures ?? [];
  for (const failure of failures) {
    process.stderr.write(`${FRAMEWORK_NAME}: plugin ${failure.package}: ${failure.reason}\n`);
  }
  for (const failure of report.claudePluginFailures ?? []) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: capability ${failure.capability}: ${failure.reason}\n`,
    );
    process.exitCode = 1;
  }
  if (report.audienceError) {
    process.stderr.write(`${FRAMEWORK_NAME}: ${report.audienceError}\n`);
    process.exitCode = 1;
  }
  if (failures.length > 0) process.exitCode = 1;
}
