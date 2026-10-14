import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

import { getOpenSpecSchemaSelection } from "../../../lib/orchestrator/setup-compatibilities";
import { getWrapperBinPath } from "../../../lib/package-paths";
import { fetchPublicPackageVersion } from "../../../lib/public-npm";
import { isNewer, isPinnedDeployment } from "../../../lib/update-checker";
import { FRAMEWORK_NAME } from "../../../framework";
import { confirm } from "../../../cli/confirm";
import type { CapabilityPlugin, RuntimeContributionsByRuntime, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import {
  isCommandOnPath,
  mergeDir,
  pruneEmptyAncestors,
  resolveCommandOnPath,
  runCommand,
  runCommandSilently,
} from "../utils";
import { applyMateSkills, MANAGED_MATE_SKILL_NAMES, teardownMateSkills } from "../mate";
import {
  getSharedSkillsDir,
  isSharedSkillRootActive,
  removeLegacyOpenCodeSkills,
  removeSharedSkills,
} from "../providers/agents-skill-root";

export { MATE_ARTIFACT_SKILLS, MATE_SKILLS } from "../mate";

const execFileAsync = promisify(execFileCb);

export const OPENSPEC_SKILLS = [
  "openspec-explore",
  "openspec-propose",
  "openspec-apply-change",
  "openspec-archive-change",
  "openspec-sync-specs",
  "openspec-update-change",
] as const;

/** Written by the OpenSpec `agents` tool beside its skills in the shared root. */
const OPENSPEC_AGENTS_MARKER = ".openspec-target";

/** Skill names the capability owns in any skill root. */
const MANAGED_SKILL_NAMES = [...OPENSPEC_SKILLS, ...MANAGED_MATE_SKILL_NAMES];

/** Every Mate-owned schema is installed for availability; only one is ever activated as the companion default. */
const MATE_SCHEMA_NAMES = ["mate-v1", "mate-minimal"] as const;

const MATE_SCHEMA_SOURCE_ROOT = path.join(
  import.meta.dirname,
  "../../../templates/capabilities/openspec-cap",
);
const MATE_CONVENTIONS_SOURCE = path.join(MATE_SCHEMA_SOURCE_ROOT, "openspec-conventions.yaml");

/**
 * Identifies Mate's own `rules.specs` entry, so a later release can replace its
 * text instead of adding a second entry.
 */
export const MATE_SPECS_RULE_MARKER = "[mate] ";

/**
 * Delivered through `rules.specs`, the one config hook OpenSpec's archive and
 * sync workflows read when writing main specs. Propose reads it for delta specs
 * too, so the text binds main specs only.
 */
export const MATE_SPECS_RULE = `${MATE_SPECS_RULE_MARKER}A main spec at openspec/specs/<capability>/spec.md MUST begin with flat frontmatter: type: spec, capability: <capability>, repository: <org/repository> (one scalar), areas: [<area>, ...] (a flat list in the delta's scope order), and tags: [openspec/spec]. Project repository and areas from the delta's paired scopes; never copy scopes, change, or delta tags onto a main spec. Delta specs under openspec/changes/<name>/specs/ keep their delta frontmatter. Full rules: openspec/mate-conventions.yaml.`;

/** What Mate writes besides its entry; anything beyond the two is user content. */
const MANAGED_CONFIG_SCHEMA_ONLY = "schema: mate-v1";

/** Unfolded output keeps the Mate entry on one line and user scalars unwrapped. */
const CONFIG_TO_STRING = { lineWidth: 0 } as const;

/**
 * Runtime → OpenSpec CLI tools. OpenCode reads workflow skills from the shared
 * `agents` root; its own tool only contributes the `/opsx-*` commands.
 */
const OPENSPEC_TOOLS_BY_RUNTIME = {
  claude: ["claude"],
  opencode: ["agents", "opencode"],
} as const;

const OPENSPEC_INSTALL_COMMAND = "npm install -g @fission-ai/openspec@latest";

/**
 * Store metadata `openspec store register` writes beside the companion. Its id
 * is machine-local, and companion Git sync would otherwise stash it on every
 * launch. Persisted: the registration outlives the capability.
 */
const OPENSPEC_GITIGNORE_ENTRIES = [".openspec-store/"];

type OpenSpecTool =
  (typeof OPENSPEC_TOOLS_BY_RUNTIME)[keyof typeof OPENSPEC_TOOLS_BY_RUNTIME][number];
type OpenSpecRunCommand = typeof runCommandSilently;

export interface OpenSpecPluginDeps {
  runCommand?: OpenSpecRunCommand;
  installCommand?: typeof runCommand;
  isCommandOnPath?: typeof isCommandOnPath;
  confirm?: typeof confirm;
  pathValue?: () => string;
  wrapperBinPath?: () => string;
  getInstalledVersion?: (pathValue: string) => Promise<string | undefined>;
  fetchLatestVersion?: () => Promise<string | undefined>;
  isPinnedDeployment?: () => boolean;
}

async function defaultGetInstalledVersion(pathValue: string): Promise<string | undefined> {
  const bin = resolveCommandOnPath("openspec", pathValue);
  if (!bin) return undefined;

  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 10_000 });
    return stdout.match(/\d+\.\d+\.\d+/)?.[0];
  } catch {
    return undefined;
  }
}

async function defaultFetchLatestVersion(): Promise<string | undefined> {
  try {
    return await fetchPublicPackageVersion("@fission-ai/openspec");
  } catch {
    return undefined;
  }
}

export function deriveOpenSpecTools(activeProviders: string[]): OpenSpecTool[] {
  const active = new Set(activeProviders);
  return Object.entries(OPENSPEC_TOOLS_BY_RUNTIME).flatMap(([runtime, tools]) =>
    active.has(runtime) ? tools : [],
  );
}

function getClaudeSkillsDir(companionPath: string): string {
  return path.join(companionPath, ".claude", "skills");
}

function getOpenSpecConfigPath(companionPath: string): string {
  return path.join(companionPath, "openspec", "config.yaml");
}

function getMateSchemaDir(companionPath: string, schemaName: string): string {
  return path.join(companionPath, "openspec", "schemas", schemaName);
}

function getMateConventionsPath(companionPath: string): string {
  return path.join(companionPath, "openspec", "mate-conventions.yaml");
}

async function teardownClaudeSkillRoot(companionPath: string): Promise<void> {
  const skillsDir = getClaudeSkillsDir(companionPath);
  for (const skill of OPENSPEC_SKILLS) {
    try {
      await fs.rm(path.join(skillsDir, skill), { recursive: true, force: true });
    } catch {
      /* not present */
    }
  }
  await teardownMateSkills(skillsDir, companionPath);
  await pruneEmptyAncestors(skillsDir, companionPath);
}

async function teardownSharedSkillRoot(companionPath: string): Promise<void> {
  await removeSharedSkills(companionPath, [...MANAGED_SKILL_NAMES, OPENSPEC_AGENTS_MARKER]);
}

/** Converges earlier layouts and drops the `opencode` tool's duplicate workflow skills. */
async function removeLegacyOpenCodeCopies(companionPath: string): Promise<void> {
  await removeLegacyOpenCodeSkills(companionPath, MANAGED_SKILL_NAMES);
}

async function applyMateOpenspecSkills(
  companionPath: string,
  activeProviders: string[],
): Promise<void> {
  if (activeProviders.includes("claude")) {
    await applyMateSkills(getClaudeSkillsDir(companionPath), "claude");
  }
  if (isSharedSkillRootActive(activeProviders)) {
    await applyMateSkills(getSharedSkillsDir(companionPath), "agents");
  }
}

async function reconcileOpenSpecTools(
  ctx: SetupContext,
  runCommand: OpenSpecRunCommand,
): Promise<void> {
  const tools = deriveOpenSpecTools(ctx.activeProviders);
  if (tools.length === 0) return;
  /** Best-effort: `config reset` is missing on older openspec releases. */
  try {
    await runCommand("openspec", ["config", "reset", "--all", "-y"], {
      cwd: ctx.companionPath,
    });
  } catch (error) {
    process.stderr.write(
      `openspec config reset skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  await runCommand("openspec", ["init", "--tools", tools.join(","), "--force", ctx.companionPath], {
    cwd: ctx.companionPath,
  });
  await runCommand("openspec", ["update", "--force", ctx.companionPath], {
    cwd: ctx.companionPath,
  });

  await removeLegacyOpenCodeCopies(ctx.companionPath);
  await applyMateOpenspecSkills(ctx.companionPath, ctx.activeProviders);
}

async function updateOpenSpecIfOutdated(
  ctx: SetupContext,
  deps: Required<
    Pick<
      OpenSpecPluginDeps,
      | "installCommand"
      | "pathValue"
      | "getInstalledVersion"
      | "fetchLatestVersion"
      | "isPinnedDeployment"
    >
  >,
): Promise<void> {
  /** Pinned artifacts change tool versions by replacement, never reconciliation. */
  if (deps.isPinnedDeployment()) return;

  const installed = await deps.getInstalledVersion(deps.pathValue());
  if (!installed) return;

  const latest = await deps.fetchLatestVersion();
  if (!latest || !isNewer(latest, installed)) return;

  process.stdout.write(
    `openspec: installed version ${installed} is outdated (latest ${latest}). Updating now:\n  ${OPENSPEC_INSTALL_COMMAND}\n`,
  );

  try {
    await deps.installCommand("npm", ["install", "-g", "@fission-ai/openspec@latest"], {
      cwd: ctx.companionPath,
    });
  } catch {
    process.stderr.write("openspec: upgrade failed - continuing with the installed version\n");
  }
}

async function ensureOpenSpecInstalled(
  ctx: SetupContext,
  deps: Required<
    Pick<
      OpenSpecPluginDeps,
      | "installCommand"
      | "isCommandOnPath"
      | "confirm"
      | "pathValue"
      | "getInstalledVersion"
      | "fetchLatestVersion"
      | "isPinnedDeployment"
    >
  >,
): Promise<boolean> {
  if (deps.isCommandOnPath("openspec", deps.pathValue())) {
    await updateOpenSpecIfOutdated(ctx, deps);
    return true;
  }

  if (ctx.mode !== "setup") {
    process.stderr.write(
      `openspec binary not found. Install it manually with \`${OPENSPEC_INSTALL_COMMAND}\`\n`,
    );
    return false;
  }

  if (!deps.isCommandOnPath("npm", deps.pathValue())) {
    process.stderr.write(
      `openspec binary not found and npm is not available on PATH. Install it manually with \`${OPENSPEC_INSTALL_COMMAND}\`\n`,
    );
    return false;
  }

  process.stdout.write(`openspec binary not found. To install:\n  ${OPENSPEC_INSTALL_COMMAND}\n`);
  const ok = await deps.confirm("Run this install command now?");
  if (!ok) {
    process.stderr.write(
      `openspec: install skipped - install manually with \`${OPENSPEC_INSTALL_COMMAND}\`\n`,
    );
    return false;
  }

  try {
    await deps.installCommand("npm", ["install", "-g", "@fission-ai/openspec@latest"], {
      cwd: ctx.companionPath,
    });
  } catch {
    process.stderr.write(
      `openspec: install failed - install manually with \`${OPENSPEC_INSTALL_COMMAND}\`\n`,
    );
    return false;
  }

  if (!deps.isCommandOnPath("openspec", deps.pathValue())) {
    process.stderr.write(
      "openspec install completed but the binary is still not available on PATH\n",
    );
    return false;
  }

  return true;
}

function isMateSpecsRule(item: unknown): boolean {
  return (
    isScalar(item) &&
    typeof item.value === "string" &&
    item.value.startsWith(MATE_SPECS_RULE_MARKER)
  );
}

/** The config's `rules.specs` sequence, `null` when absent, or `undefined` when a shape is foreign. */
function readSpecsRules(doc: Document): YAMLSeq | null | undefined {
  if (doc.contents !== null && !isMap(doc.contents)) return undefined;
  const rules = doc.get("rules", true);
  if (rules === undefined || rules === null) return null;
  if (!isMap(rules)) return undefined;
  const specs = rules.get("specs", true);
  if (specs === undefined || specs === null) return null;
  return isSeq(specs) ? specs : undefined;
}

/**
 * Removes Mate's `rules.specs` entry and any `rules.specs` list or `rules` map
 * that leaves empty. Returns whether the document changed.
 */
function removeMateSpecsRule(doc: Document): boolean {
  const specs = readSpecsRules(doc);
  if (!specs) return false;
  const before = specs.items.length;
  specs.items = specs.items.filter((item) => !isMateSpecsRule(item));
  if (specs.items.length === before) return false;
  if (specs.items.length === 0) doc.deleteIn(["rules", "specs"]);
  const rules = doc.get("rules", true);
  if (isMap(rules) && rules.items.length === 0) doc.delete("rules");
  return true;
}

/**
 * Ensures exactly one current Mate entry in `rules.specs`: appended when
 * missing, replaced in place when outdated. Returns whether the document changed.
 */
function upsertMateSpecsRule(doc: Document): boolean {
  if (doc.contents === null) doc.contents = doc.createNode({}) as YAMLMap;
  const specs = readSpecsRules(doc);
  if (specs === null) {
    doc.setIn(["rules", "specs"], doc.createNode([MATE_SPECS_RULE]));
    return true;
  }
  if (!specs) return false;

  const index = specs.items.findIndex(isMateSpecsRule);
  if (index === -1) {
    specs.add(doc.createNode(MATE_SPECS_RULE));
    return true;
  }
  let changed = false;
  const current = specs.items[index];
  if (isScalar(current) && current.value !== MATE_SPECS_RULE) {
    current.value = MATE_SPECS_RULE;
    changed = true;
  }
  const deduplicated = specs.items.filter((item, i) => i === index || !isMateSpecsRule(item));
  if (deduplicated.length !== specs.items.length) {
    specs.items = deduplicated;
    changed = true;
  }
  return changed;
}

/**
 * Removes Mate's own config content: its `rules.specs` entry always, and the
 * file only when what remains is exactly what Mate writes. User content stays.
 */
async function removeManagedOpenSpecConfig(companionPath: string): Promise<void> {
  const configPath = getOpenSpecConfigPath(companionPath);
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch {
    return;
  }

  let remaining = content;
  if (content.trim() !== MANAGED_CONFIG_SCHEMA_ONLY) {
    const doc = parseDocument(content);
    if (doc.errors.length > 0 || !removeMateSpecsRule(doc)) return;
    remaining = doc.toString(CONFIG_TO_STRING);
  }

  if (remaining.trim() === MANAGED_CONFIG_SCHEMA_ONLY) {
    await fs.rm(configPath, { force: true });
    await pruneEmptyAncestors(path.dirname(configPath), companionPath);
  } else {
    await fs.writeFile(configPath, remaining, "utf8");
  }
}

/** Writes a fresh Mate config, or merges Mate's entry into an existing one; writes only on change. */
async function ensureManagedOpenSpecConfig(companionPath: string): Promise<void> {
  const configPath = getOpenSpecConfigPath(companionPath);
  let content: string | undefined;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch {
    /* no config yet */
  }

  if (content === undefined) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const fresh = new Document({ schema: "mate-v1", rules: { specs: [MATE_SPECS_RULE] } });
    await fs.writeFile(configPath, fresh.toString(CONFIG_TO_STRING), "utf8");
    return;
  }

  // config.yaml is user-editable once created; only Mate's own entry is touched.
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    process.stderr.write(
      `openspec: left openspec/config.yaml unchanged, it is not valid YAML: ${doc.errors[0].message.split("\n")[0]}\n`,
    );
    return;
  }
  if (!upsertMateSpecsRule(doc)) return;
  const merged = doc.toString(CONFIG_TO_STRING);
  if (merged !== content) await fs.writeFile(configPath, merged, "utf8");
}

async function teardownOpenSpecSchema(companionPath: string): Promise<void> {
  for (const schemaName of MATE_SCHEMA_NAMES) {
    const schemaDir = getMateSchemaDir(companionPath, schemaName);
    await fs.rm(schemaDir, { recursive: true, force: true });
    await pruneEmptyAncestors(schemaDir, companionPath);
  }

  await fs.rm(getMateConventionsPath(companionPath), { force: true });
  await removeManagedOpenSpecConfig(companionPath);
}

async function reconcileOpenSpecSchema(ctx: SetupContext): Promise<void> {
  await Promise.all(
    MATE_SCHEMA_NAMES.map((schemaName) =>
      mergeDir(
        path.join(MATE_SCHEMA_SOURCE_ROOT, schemaName),
        getMateSchemaDir(ctx.companionPath, schemaName),
      ),
    ),
  );
  await fs.rm(
    path.join(getMateSchemaDir(ctx.companionPath, "mate-v1"), "templates", "explore-brief.md"),
    { force: true },
  );
  await fs.copyFile(MATE_CONVENTIONS_SOURCE, getMateConventionsPath(ctx.companionPath));

  // Availability is unconditional so any change may select a Mate schema;
  // activation stays opt-in through the companion-level setup selection.
  if (getOpenSpecSchemaSelection(ctx.config.capabilities ?? []) !== "mate-v1") {
    await removeManagedOpenSpecConfig(ctx.companionPath);
    return;
  }

  await ensureManagedOpenSpecConfig(ctx.companionPath);
}

export function createOpenspecPlugin(deps: OpenSpecPluginDeps = {}): CapabilityPlugin {
  const depsWithDefaults = {
    runCommand: deps.runCommand ?? runCommandSilently,
    installCommand: deps.installCommand ?? runCommand,
    isCommandOnPath: deps.isCommandOnPath ?? isCommandOnPath,
    confirm: deps.confirm ?? confirm,
    pathValue: deps.pathValue ?? (() => process.env.PATH ?? ""),
    wrapperBinPath: deps.wrapperBinPath ?? getWrapperBinPath,
    getInstalledVersion: deps.getInstalledVersion ?? defaultGetInstalledVersion,
    fetchLatestVersion: deps.fetchLatestVersion ?? defaultFetchLatestVersion,
    isPinnedDeployment: deps.isPinnedDeployment ?? (() => isPinnedDeployment()),
  };

  return {
    id: "openspec",
    kind: "capability",
    label: "OpenSpec",
    description: "Route OpenSpec commands to the companion root and enable planning workflows.",
    defaultSelected: true,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "openspec"),
    // Permission pre-seeds are declared and reconciled by the Claude Runtime
    // Surface. Skill trees stay imperative on purpose: the workflow skills are
    // written by the external `openspec` CLI (foreign trees), and the
    // mate-authored skills are git-mode-conditional with per-tool sources.
    getRuntimeContributions(): RuntimeContributionsByRuntime {
      return {
        claude: {
          permissionEntries: [
            "Skill(openspec-explore)",
            "Skill(openspec-propose)",
            "Skill(openspec-apply-change)",
            "Skill(openspec-archive-change)",
            "Skill(mate-artifact-publish)",
            "Skill(mate-openspec-backfill)",
            "Skill(mate-interview-me)",
            "Skill(mate-grill-me)",
            "Skill(mate-grilling)",
            "Skill(mate-grill-with-docs)",
            "Skill(mate-domain-modeling)",
            "Skill(mate-show-me)",
            "Skill(mate-simplify-code)",
            "Bash(openspec:*)",
            `Bash(${FRAMEWORK_NAME} cap graphify:*)`,
            `Bash(${path.join(depsWithDefaults.wrapperBinPath(), "openspec")}:*)`,
          ],
        },
      };
    },
    gitignoreEntries: () => OPENSPEC_GITIGNORE_ENTRIES,
    persistGitignoreEntries: true,
    getInstallRequirements: (): InstallRequirement[] => [
      {
        id: "capability:openspec",
        label: "OpenSpec CLI",
        group: "companion",
        source: "OpenSpec capability",
        command: OPENSPEC_INSTALL_COMMAND,
        fingerprint: `openspec:${OPENSPEC_INSTALL_COMMAND}`,
        detect: () => depsWithDefaults.isCommandOnPath("openspec", depsWithDefaults.pathValue()),
        install: () =>
          depsWithDefaults.installCommand("npm", ["install", "-g", "@fission-ai/openspec@latest"]),
        verify: () => depsWithDefaults.isCommandOnPath("openspec", depsWithDefaults.pathValue()),
      },
    ],
    async apply(ctx) {
      const tools = deriveOpenSpecTools(ctx.activeProviders);
      if (ctx.mode === "setup" || tools.length > 0) {
        if (await ensureOpenSpecInstalled(ctx, depsWithDefaults)) {
          if (tools.length > 0) {
            await reconcileOpenSpecTools(ctx, depsWithDefaults.runCommand);
          }
        }
      }
      await removeLegacyOpenCodeCopies(ctx.companionPath);
      await reconcileOpenSpecSchema(ctx);
    },
    async teardown(ctx) {
      await teardownClaudeSkillRoot(ctx.companionPath);
      await teardownSharedSkillRoot(ctx.companionPath);
      await removeLegacyOpenCodeCopies(ctx.companionPath);
      await teardownOpenSpecSchema(ctx.companionPath);
    },
    forProvider: {
      claude: {
        // Publication is explicit (`mate-artifact-publish`), so openspec
        // contributes no archive-triggered Claude hook and no hook state.
        async apply() {},
        async teardown(ctx: SetupContext) {
          await teardownClaudeSkillRoot(ctx.companionPath);
        },
      },
      opencode: {
        async apply() {},
        async teardown(ctx: SetupContext) {
          if (!isSharedSkillRootActive(ctx.activeProviders)) {
            await teardownSharedSkillRoot(ctx.companionPath);
          }
          await removeLegacyOpenCodeCopies(ctx.companionPath);
        },
      },
    },
  };
}
