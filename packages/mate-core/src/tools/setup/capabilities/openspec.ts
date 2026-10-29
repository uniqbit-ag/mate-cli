import fs from "node:fs/promises";
import path from "node:path";

import { Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

import {
  locateOpenSpec,
  runOpenSpec,
  type OpenSpecLocation,
  type RunOpenSpec,
} from "../../../lib/openspec-cli";
import { getWrapperBinPath } from "../../../lib/package-paths";
import { FRAMEWORK_NAME } from "../../../framework";
import { removeRecorded } from "../managed-output";
import type {
  CapabilityPlugin,
  ManagedOutputRecorder,
  RuntimeContributionsByRuntime,
  SetupContext,
} from "../plugin";
import { mergeDir, pruneEmptyAncestors } from "../utils";
import { applyMateSkills, MATE_SKILLS, readSkillAuthor, teardownMateSkills } from "../mate";
import { getSharedSkillsDir, isSharedSkillRootActive } from "../providers/agents-skill-root";

export { MATE_SKILLS } from "../mate";

export const OPENSPEC_SKILLS = [
  "openspec-explore",
  "openspec-propose",
  "openspec-apply-change",
  "openspec-archive-change",
  "openspec-sync-specs",
  "openspec-update-change",
] as const;

/** Mate skills without a pre-seeded `Skill(...)` permission. */
const UNPERMITTED_MATE_SKILLS: ReadonlySet<string> = new Set(["mate-create-report"]);

/** Written by the OpenSpec `agents` tool beside its skills in the shared root. */
const OPENSPEC_AGENTS_MARKER = ".openspec-target";

/** Command ids the OpenSpec CLI writes as `.claude/commands/opsx/<id>.md` and `.opencode/commands/opsx-<id>.md`. */
const OPENSPEC_COMMAND_IDS = [
  "explore",
  "new",
  "continue",
  "apply",
  "update",
  "ff",
  "sync",
  "archive",
  "bulk-archive",
  "verify",
  "onboard",
  "propose",
] as const;

/** Skill roots earlier Mate versions let the OpenSpec CLI generate workflow skills into. */
const GENERATED_SKILL_ROOTS = [".claude", ".agents", ".opencode"] as const;

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
export const MATE_SPECS_RULE = `${MATE_SPECS_RULE_MARKER}A main spec at openspec/specs/<capability>/spec.md MUST begin with flat frontmatter: type: spec, capability: <capability>, repository: <org/repository> (one scalar), areas: [<area>, ...] (a flat list in the delta's scope order), and tags: [openspec/spec]. Project repository and areas from the delta's paired scopes; never copy scopes, change, or delta tags onto a main spec. Delta specs under openspec/changes/<name>/specs/ keep their \`mate:delta\` comment. Full rules: openspec/mate-conventions.yaml.`;

/** What Mate writes besides its entry; anything beyond the two is user content. */
const MANAGED_CONFIG_SCHEMA_ONLY = "schema: mate-v1";

/** The schema a fresh `openspec init` writes into config.yaml. */
const OPENSPEC_INIT_SCHEMA = "spec-driven";

/** Unfolded output keeps the Mate entry on one line and user scalars unwrapped. */
const CONFIG_TO_STRING = { lineWidth: 0 } as const;

/**
 * Store metadata `openspec store register` writes beside the companion. Its id
 * is machine-local, and companion Git sync would otherwise stash it on every
 * launch. Persisted: the registration outlives the capability.
 */
const OPENSPEC_GITIGNORE_ENTRIES = [".openspec-store/"];

export interface OpenSpecPluginDeps {
  runOpenSpec?: RunOpenSpec;
  locateOpenSpec?: () => OpenSpecLocation;
  wrapperBinPath?: () => string;
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

async function teardownClaudeSkillRoot(
  companionPath: string,
  recorder?: ManagedOutputRecorder,
): Promise<void> {
  const skillsDir = getClaudeSkillsDir(companionPath);
  for (const skill of OPENSPEC_SKILLS) {
    try {
      await removeRecorded(path.join(skillsDir, skill), "openspec", recorder);
    } catch {
      /* not present */
    }
  }
  await teardownMateSkills(skillsDir, companionPath, recorder);
  await pruneEmptyAncestors(skillsDir, companionPath);
}

async function teardownSharedSkillRoot(
  companionPath: string,
  recorder?: ManagedOutputRecorder,
): Promise<void> {
  const skillsDir = getSharedSkillsDir(companionPath);
  await teardownMateSkills(skillsDir, companionPath, recorder);
  for (const name of [...OPENSPEC_SKILLS, OPENSPEC_AGENTS_MARKER]) {
    await removeRecorded(path.join(skillsDir, name), "openspec", recorder);
  }
  await pruneEmptyAncestors(skillsDir, companionPath);
}

/** Converges the earlier layout that deployed Mate skills into `.opencode/skills`. */
async function removeLegacyOpenCodeCopies(
  companionPath: string,
  recorder?: ManagedOutputRecorder,
): Promise<void> {
  await teardownMateSkills(
    path.join(companionPath, ".opencode", "skills"),
    companionPath,
    recorder,
  );
}

/** The `openspec-*` skills in `skillsDir` OpenSpec wrote: the known names, or `author: openspec`. */
async function generatedOpenSpecSkills(skillsDir: string): Promise<string[]> {
  const names = (await fs.readdir(skillsDir).catch(() => [])).filter((name) =>
    name.startsWith("openspec-"),
  );
  const generated = await Promise.all(
    names.map(async (name) => {
      const dir = path.join(skillsDir, name);
      const known = (OPENSPEC_SKILLS as readonly string[]).includes(name);
      return known || (await readSkillAuthor(dir)) === "openspec" ? [dir] : [];
    }),
  );
  return generated.flat();
}

/** Removes OpenSpec-generated output by name or authorship; user and third-party entries stay. */
async function removeGeneratedOpenSpecOutput(
  companionPath: string,
  recorder?: ManagedOutputRecorder,
): Promise<void> {
  const skills = await Promise.all(
    GENERATED_SKILL_ROOTS.map((root) =>
      generatedOpenSpecSkills(path.join(companionPath, root, "skills")),
    ),
  );
  const targets = [
    ...skills.flat(),
    path.join(getSharedSkillsDir(companionPath), OPENSPEC_AGENTS_MARKER),
    ...OPENSPEC_COMMAND_IDS.flatMap((id) => [
      path.join(companionPath, ".claude", "commands", "opsx", `${id}.md`),
      path.join(companionPath, ".opencode", "commands", `opsx-${id}.md`),
    ]),
  ];
  await Promise.all(targets.map((target) => removeRecorded(target, "openspec", recorder)));
  // Sequential: the parent directories share ancestors.
  for (const dir of new Set(targets.map((target) => path.dirname(target)))) {
    // oxlint-disable-next-line no-await-in-loop
    await pruneEmptyAncestors(dir, companionPath);
  }
}

async function applyMateOpenspecSkills(ctx: SetupContext): Promise<void> {
  if (ctx.activeProviders.includes("claude")) {
    await applyMateSkills(getClaudeSkillsDir(ctx.companionPath), "claude", ctx.managedOutput);
  }
  if (isSharedSkillRootActive(ctx.activeProviders)) {
    await applyMateSkills(getSharedSkillsDir(ctx.companionPath), "agents", ctx.managedOutput);
  }
}

/**
 * Initializes OpenSpec without tool output, so it writes only its `openspec/`
 * scaffolding: Mate carries the workflow text in its own skills.
 */
async function initializeOpenSpec(ctx: SetupContext, run: RunOpenSpec): Promise<void> {
  const args = ["init", "--tools", "none", "--force", ctx.companionPath];
  const result = await run(args, { cwd: ctx.companionPath });
  if (result.code !== 0) {
    // A missing bundled CLI answers its reinstall message as stderr.
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`openspec ${args.join(" ")} exited with code ${result.code}: ${detail}`);
  }
  await removeGeneratedOpenSpecOutput(ctx.companionPath, ctx.managedOutput);
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

  // config.yaml is user-editable once created; only Mate's entry and a default `schema` are touched.
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    process.stderr.write(
      `openspec: left openspec/config.yaml unchanged, it is not valid YAML: ${doc.errors[0].message.split("\n")[0]}\n`,
    );
    return;
  }
  const ruleChanged = upsertMateSpecsRule(doc);
  // Mate's `mate-v1` replaces a missing schema or the one `openspec init` writes; any other is a user choice.
  const current = isMap(doc.contents) ? doc.get("schema") : undefined;
  const schemaChanged =
    isMap(doc.contents) &&
    (current === undefined || current === null || current === OPENSPEC_INIT_SCHEMA);
  if (schemaChanged) doc.set("schema", "mate-v1");
  if (!schemaChanged && !ruleChanged) return;
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

  await ensureManagedOpenSpecConfig(ctx.companionPath);
}

export function createOpenspecPlugin(deps: OpenSpecPluginDeps = {}): CapabilityPlugin {
  const depsWithDefaults = {
    runOpenSpec: deps.runOpenSpec ?? runOpenSpec,
    locateOpenSpec: deps.locateOpenSpec ?? locateOpenSpec,
    wrapperBinPath: deps.wrapperBinPath ?? getWrapperBinPath,
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
            ...MATE_SKILLS.filter((skill) => !UNPERMITTED_MATE_SKILLS.has(skill)).map(
              (skill) => `Skill(${skill})`,
            ),
            "Bash(openspec:*)",
            `Bash(${FRAMEWORK_NAME} cap graphify:*)`,
            `Bash(${path.join(depsWithDefaults.wrapperBinPath(), "openspec")}:*)`,
          ],
        },
      };
    },
    gitignoreEntries: () => OPENSPEC_GITIGNORE_ENTRIES,
    persistGitignoreEntries: true,
    async apply(ctx) {
      // OpenSpec output is committed in the companion, so only setup and
      // `mate companion update` touch it; a launch must leave it alone.
      if (ctx.mode === "setup" || ctx.regenerateOpenSpec === true) {
        await initializeOpenSpec(ctx, depsWithDefaults.runOpenSpec);
      } else {
        const location = depsWithDefaults.locateOpenSpec();
        if ("missing" in location) process.stderr.write(`openspec: ${location.missing}\n`);
      }
      await applyMateOpenspecSkills(ctx);
      await removeLegacyOpenCodeCopies(ctx.companionPath, ctx.managedOutput);
      await reconcileOpenSpecSchema(ctx);
    },
    async teardown(ctx) {
      await teardownClaudeSkillRoot(ctx.companionPath, ctx.managedOutput);
      await teardownSharedSkillRoot(ctx.companionPath, ctx.managedOutput);
      await removeLegacyOpenCodeCopies(ctx.companionPath, ctx.managedOutput);
      await removeGeneratedOpenSpecOutput(ctx.companionPath, ctx.managedOutput);
      await teardownOpenSpecSchema(ctx.companionPath);
    },
    forProvider: {
      claude: {
        // Publication is explicit (`mate-publish-artifact`), so openspec
        // contributes no archive-triggered Claude hook and no hook state.
        async apply() {},
        async teardown(ctx: SetupContext) {
          await teardownClaudeSkillRoot(ctx.companionPath, ctx.managedOutput);
        },
      },
      opencode: {
        async apply() {},
        async teardown(ctx: SetupContext) {
          if (!isSharedSkillRootActive(ctx.activeProviders)) {
            await teardownSharedSkillRoot(ctx.companionPath, ctx.managedOutput);
          }
          await removeLegacyOpenCodeCopies(ctx.companionPath, ctx.managedOutput);
        },
      },
    },
  };
}
