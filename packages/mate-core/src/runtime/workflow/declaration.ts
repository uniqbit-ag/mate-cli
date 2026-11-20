import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";

import { folderPattern, patternsOverlap } from "./globs";
import {
  BUILTIN_ARTIFACT_TYPE,
  BUILTIN_BY_ID,
  BUILTIN_BY_SKILL,
  defaultWorkflow,
  mateStageSkill,
  skillStageOf,
  WORKFLOW_FILE,
  WORKFLOW_VERSION,
  type DeclaredArtifactType,
  type Workflow,
  type WorkflowHook,
  type WorkflowProblem,
  type WorkflowReview,
  type WorkflowStage,
  type WorkflowVerdict,
} from "./workflow";

export * from "./workflow";

/**
 * Reads a companion's workflow declaration: parsed and validated as a whole, so every reader
 * sees one verdict; an invalid file never falls back to the default. Under `runtime/`, since
 * session guidance and the session banner read it without a launch.
 */

/** The built-in type's folders, as `lib/change-layout` names them; `runtime/` may not import it. */
const CHANGES_RELATIVE_DIR = "openspec/changes";
const SPECS_RELATIVE_DIR = "openspec/specs";

/** Never a step: the deprecated alias of submit. */
const FORBIDDEN_STEP = "mate-archive-change";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const keyAt = (at: string, key: string): string => (at ? `${at}.${key}` : key);

/** `security-review` → `Security review`. */
function labelOf(id: string): string {
  const words = id.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

class Problems {
  readonly list: WorkflowProblem[] = [];

  add(at: string, message: string): void {
    this.list.push({ path: at, message });
  }

  unknownKeys(value: Record<string, unknown>, known: readonly string[], at: string): void {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) this.add(keyAt(at, key), `unknown key \`${key}\``);
    }
  }
}

/** Anchors and aliases anywhere below `node`, by key path. */
function findAnchors(node: unknown, at: string, problems: Problems): void {
  if (isAlias(node)) {
    problems.add(at, "aliases are not allowed");
    return;
  }
  if (!isNode(node)) return;
  if (node.anchor) problems.add(at, "anchors are not allowed");
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "?";
      findAnchors(pair.key, keyAt(at, key), problems);
      findAnchors(pair.value, keyAt(at, key), problems);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => findAnchors(item, `${at}[${index}]`, problems));
  }
}

/** Why `value` is not a relative path inside the companion, or null. */
function pathProblem(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return "must be a path";
  if (value.includes("\\")) return "uses `/` as its separator";
  if (value.startsWith("/")) return "must be relative to the companion";
  const segments = value.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must stay inside the companion, without `.`, `..` or empty segments";
  }
  if (segments[0] === ".mate") return "`.mate/` is Mate's";
  return null;
}

/** Why `value` is not a folder template ending in `placeholder`, or null. */
function templateProblem(value: unknown, placeholder: string): string | null {
  const problem = pathProblem(value);
  if (problem) return problem;
  const segments = (value as string).replace(/\/$/, "").split("/");
  if (segments.at(-1) !== placeholder || segments.length < 2) {
    return `must be a folder path ending in \`${placeholder}\`, such as \`notes/${placeholder}/\``;
  }
  if (segments.slice(0, -1).some((segment) => /[{}*?[\]]/.test(segment))) {
    return `holds \`${placeholder}\` as its last segment and no other placeholder or wildcard`;
  }
  return null;
}

/** The hooks Mate ships for declared types, by where they run; none yet. */
const BUILTIN_HOOKS: Record<string, readonly string[]> = {
  "submit.check": [],
  "publish.apply": [],
  "publish.validate": [],
};

function parseHook(
  value: unknown,
  group: string,
  type: DeclaredArtifactType,
  at: string,
  problems: Problems,
): WorkflowHook | undefined {
  const keys = isRecord(value) ? Object.keys(value) : [];
  const [key] = keys;
  if (keys.length !== 1 || (key !== "builtin" && key !== "run")) {
    problems.add(at, "a hook is `builtin` or `run`");
    return undefined;
  }
  const text = (value as Record<string, unknown>)[key];
  if (typeof text !== "string" || text.trim() === "") {
    problems.add(keyAt(at, key), `\`${key}\` must be text`);
    return undefined;
  }
  if (key === "builtin") {
    if (!BUILTIN_HOOKS[group]!.includes(text)) {
      problems.add(keyAt(at, key), `Mate ships no built-in \`${group}\` hook named \`${text}\``);
      return undefined;
    }
    return { builtin: text };
  }
  if (text.includes("{archive}") && type.archive === undefined) {
    problems.add(keyAt(at, key), "`{archive}` needs the type to declare `archive`");
  }
  return { run: text };
}

function parseReviews(value: unknown, at: string, problems: Problems): WorkflowReview[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    problems.add(at, "`reviews` maps an artifact id to a file in the change folder");
    return [];
  }
  const reviews: WorkflowReview[] = [];
  for (const [id, file] of Object.entries(value)) {
    const entry = keyAt(at, id);
    if (!NAME.test(id)) {
      problems.add(entry, "an artifact id uses lower-case letters, digits and hyphens");
      continue;
    }
    const problem =
      typeof file === "string" && file.endsWith("/") ? "must be a file" : pathProblem(file);
    if (problem) {
      problems.add(entry, problem);
      continue;
    }
    reviews.push({ id, file: file as string });
  }
  return reviews;
}

function parseArtifactType(
  name: string,
  value: unknown,
  problems: Problems,
): DeclaredArtifactType | null {
  const at = keyAt("artifacts", name);
  if (name === BUILTIN_ARTIFACT_TYPE) {
    problems.add(at, `the type \`${name}\` is built in and is not declared`);
    return null;
  }
  if (!NAME.test(name)) {
    problems.add(at, "a type name uses lower-case letters, digits and hyphens");
    return null;
  }
  if (!isRecord(value)) {
    problems.add(at, "an artifact type is a mapping");
    return null;
  }
  problems.unknownKeys(
    value,
    ["change", "published", "archive", "reviews", "submit", "publish"],
    at,
  );
  const before = problems.list.length;

  const changeProblem = templateProblem(value.change, "{name}");
  if (changeProblem) problems.add(keyAt(at, "change"), changeProblem);
  if (value.archive !== undefined) {
    const archiveProblem = templateProblem(value.archive, "{id}");
    if (archiveProblem) problems.add(keyAt(at, "archive"), archiveProblem);
  }

  const published: string[] = [];
  if (!Array.isArray(value.published) || value.published.length === 0) {
    problems.add(keyAt(at, "published"), "`published` lists at least one path glob");
  } else {
    value.published.forEach((glob, index) => {
      const entry = `${keyAt(at, "published")}[${index}]`;
      const problem =
        pathProblem(glob) ??
        (/[{}[\]!]/.test(glob as string) ? "uses only `*`, `?` and `**` as wildcards" : null);
      if (problem) problems.add(entry, problem);
      else published.push(glob as string);
    });
  }

  const type: DeclaredArtifactType = {
    name,
    change: value.change as string,
    published,
    ...(value.archive === undefined ? {} : { archive: value.archive as string }),
    reviews: parseReviews(value.reviews, keyAt(at, "reviews"), problems),
    hooks: { apply: { run: "" } },
  };

  const submit = value.submit;
  if (submit !== undefined) {
    if (!isRecord(submit)) {
      problems.add(keyAt(at, "submit"), "`submit` is a mapping with `check`");
    } else {
      problems.unknownKeys(submit, ["check"], keyAt(at, "submit"));
      if (submit.check !== undefined) {
        const check = parseHook(submit.check, "submit.check", type, `${at}.submit.check`, problems);
        if (check) type.hooks.check = check;
      }
    }
  }

  const publish = value.publish;
  if (!isRecord(publish)) {
    problems.add(keyAt(at, "publish"), "`publish` is a mapping with `apply`");
  } else {
    problems.unknownKeys(publish, ["apply", "validate"], keyAt(at, "publish"));
    if (publish.apply === undefined) {
      problems.add(`${at}.publish.apply`, "`publish.apply` is required");
    } else {
      const apply = parseHook(
        publish.apply,
        "publish.apply",
        type,
        `${at}.publish.apply`,
        problems,
      );
      if (apply) type.hooks.apply = apply;
    }
    if (publish.validate !== undefined) {
      const validate = parseHook(
        publish.validate,
        "publish.validate",
        type,
        `${at}.publish.validate`,
        problems,
      );
      if (validate) type.hooks.validate = validate;
    }
  }

  return problems.list.length === before ? type : null;
}

interface OwnedPattern {
  /** Key path, or null for a path Mate owns. */
  at: string | null;
  type: string;
  pattern: string;
  published: boolean;
  owner: string;
}

/** The paths no declared type may overlap: the built-in type's and Mate's own folder. */
const RESERVED_PATTERNS: readonly OwnedPattern[] = [
  { pattern: `${CHANGES_RELATIVE_DIR}/**`, owner: "overlaps the built-in type's changes" },
  { pattern: `${SPECS_RELATIVE_DIR}/**`, owner: "overlaps the built-in type's specs" },
  { pattern: ".mate/**", owner: "`.mate/` is Mate's" },
].map((entry) => ({ at: null, type: "", published: false, ...entry }));

function findOverlaps(types: readonly DeclaredArtifactType[], problems: Problems): void {
  const owned: OwnedPattern[] = [...RESERVED_PATTERNS];
  for (const type of types) {
    const at = keyAt("artifacts", type.name);
    const mine: OwnedPattern[] = [
      {
        at: keyAt(at, "change"),
        type: type.name,
        pattern: folderPattern(type.change),
        published: false,
        owner: "",
      },
      ...(type.archive === undefined
        ? []
        : [
            {
              at: keyAt(at, "archive"),
              type: type.name,
              pattern: folderPattern(type.archive),
              published: false,
              owner: "",
            },
          ]),
      ...type.published.map((pattern, index) => ({
        at: `${keyAt(at, "published")}[${index}]`,
        type: type.name,
        pattern,
        published: true,
        owner: "",
      })),
    ];
    for (const entry of mine) {
      for (const other of owned) {
        // One type's published globs may overlap each other.
        if (entry.published && other.published && entry.type === other.type) continue;
        if (!patternsOverlap(entry.pattern, other.pattern)) continue;
        problems.add(entry.at!, other.at === null ? other.owner : `overlaps \`${other.at}\``);
      }
      owned.push(entry);
    }
  }
}

function parseArtifacts(value: unknown, problems: Problems): DeclaredArtifactType[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    problems.add("artifacts", "`artifacts` maps a type name to its paths and hooks");
    return [];
  }
  const types = Object.entries(value).flatMap(([name, entry]) => {
    const type = parseArtifactType(name, entry, problems);
    return type ? [type] : [];
  });
  findOverlaps(types, problems);
  return types;
}

function parseSteps(
  value: unknown,
  stage: string | undefined,
  at: string,
  problems: Problems,
  owners: Map<string, string>,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    problems.add(at, "`steps` lists at least one `{ skill: <name> }`");
    return [];
  }
  const skills: string[] = [];
  value.forEach((step, index) => {
    const entry = `${at}[${index}]`;
    if (!isRecord(step)) {
      problems.add(entry, "a step is a mapping: `{ skill: <name> }`");
      return;
    }
    const keys = Object.keys(step);
    if (keys.length !== 1 || keys[0] !== "skill") {
      problems.add(entry, "a step names a `skill` and nothing else");
      return;
    }
    const skill = step.skill;
    const skillAt = keyAt(entry, "skill");
    if (typeof skill !== "string" || !NAME.test(skill)) {
      problems.add(skillAt, "a skill name uses lower-case letters, digits and hyphens");
      return;
    }
    if (skill === FORBIDDEN_STEP) {
      problems.add(skillAt, `\`${skill}\` is never a step`);
      return;
    }
    const owner = BUILTIN_BY_SKILL.get(skill);
    if (owner && owner.id !== stage) {
      problems.add(skillAt, `\`${skill}\` belongs to \`${owner.id}\``);
      return;
    }
    // A skill names its stage, and a recorded skill identifies one step.
    if (skills.includes(skill)) {
      problems.add(skillAt, `\`${skill}\` appears twice in its stage`);
      return;
    }
    const other = owners.get(skill);
    if (other !== undefined) {
      problems.add(
        skillAt,
        `\`${skill}\` is already a step of \`${other}\`; a skill is one step of the Delivery Path`,
      );
      return;
    }
    owners.set(skill, stage ?? at);
    skills.push(skill);
  });
  return skills;
}

function parseReview(value: unknown, at: string, problems: Problems): "schema" | string[] {
  if (value === "schema") return "schema";
  if (!Array.isArray(value) || value.length === 0) {
    problems.add(at, "`review` is `schema` or a list of artifact ids");
    return [];
  }
  const ids: string[] = [];
  value.forEach((id, index) => {
    if (typeof id !== "string" || !NAME.test(id)) {
      problems.add(`${at}[${index}]`, "an artifact id uses lower-case letters, digits and hyphens");
    } else if (ids.includes(id)) {
      problems.add(`${at}[${index}]`, `\`${id}\` is listed twice`);
    } else {
      ids.push(id);
    }
  });
  return ids;
}

const STAGE_KEYS = ["id", "label", "optional", "steps", "review", "artifact"] as const;

interface ParsedStages {
  stages: WorkflowStage[];
  submitArtifact: string;
}

function parseStages(
  value: unknown,
  types: readonly DeclaredArtifactType[],
  problems: Problems,
): ParsedStages {
  const result: ParsedStages = { stages: [], submitArtifact: BUILTIN_ARTIFACT_TYPE };
  if (value === undefined) {
    problems.add("stages", "a custom workflow declares its `stages`");
    return result;
  }
  if (!Array.isArray(value) || value.length === 0) {
    problems.add("stages", "`stages` is a list ending with `submit` then `publish`");
    return result;
  }
  const ids: Array<string | undefined> = [];
  const reviewed = new Set<string>();
  /** Skill → the stage it is a step of. */
  const owners = new Map<string, string>();
  value.forEach((entry, index) => {
    const at = `stages[${index}]`;
    if (!isRecord(entry)) {
      problems.add(at, "a stage is a mapping with `id` and `steps` or `review`");
      ids.push(undefined);
      return;
    }
    problems.unknownKeys(entry, STAGE_KEYS, at);

    let id: string | undefined;
    if (typeof entry.id !== "string" || !NAME.test(entry.id)) {
      problems.add(keyAt(at, "id"), "a stage id uses lower-case letters, digits and hyphens");
    } else if (ids.includes(entry.id)) {
      problems.add(keyAt(at, "id"), `duplicate stage id \`${entry.id}\``);
    } else {
      id = entry.id;
    }
    ids.push(id);

    if (
      entry.label !== undefined &&
      (typeof entry.label !== "string" || entry.label.trim() === "")
    ) {
      problems.add(keyAt(at, "label"), "`label` must be text");
    }
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
      problems.add(keyAt(at, "optional"), "`optional` is `true` or `false`");
    }
    const optional = entry.optional === true;
    const label =
      typeof entry.label === "string" && entry.label.trim() !== ""
        ? entry.label
        : (BUILTIN_BY_ID.get(id ?? "")?.label ?? labelOf(id ?? ""));

    if (entry.artifact !== undefined) {
      const artifactAt = keyAt(at, "artifact");
      if (id !== "submit") {
        problems.add(artifactAt, "only `submit` sets `artifact`");
      } else if (
        entry.artifact !== BUILTIN_ARTIFACT_TYPE &&
        !types.some((type) => type.name === entry.artifact)
      ) {
        problems.add(artifactAt, `unknown artifact type \`${String(entry.artifact)}\``);
      } else {
        result.submitArtifact = entry.artifact as string;
      }
    }

    const hasSteps = entry.steps !== undefined;
    const hasReview = entry.review !== undefined;
    if (hasSteps === hasReview) {
      problems.add(
        at,
        hasSteps
          ? "a stage has `steps` or `review`, not both"
          : "a stage needs `steps` or `review`",
      );
      return;
    }
    if (hasReview) {
      const review = parseReview(entry.review, keyAt(at, "review"), problems);
      // `schema` names every artifact, so it shares the path with no other review stage.
      const again =
        review === "schema" ? reviewed.size > 0 : review.some((artifact) => reviewed.has(artifact));
      if (again || reviewed.has("schema")) {
        problems.add(keyAt(at, "review"), "an artifact is reviewed in one review stage only");
      }
      for (const artifact of review === "schema" ? ["schema"] : review) reviewed.add(artifact);
      if (id !== undefined) {
        result.stages.push({ id, label, kind: "review", optional, source: "declared", review });
      }
      return;
    }
    const skills = parseSteps(entry.steps, id, keyAt(at, "steps"), problems, owners);
    if (id !== undefined) result.stages.push(skillStageOf(id, label, optional, skills, "declared"));
  });

  const publishAt = ids.indexOf("publish");
  const ends = ids.length >= 2 && ids.at(-2) === "submit" && ids.at(-1) === "publish";
  if (!ends) {
    const after =
      publishAt >= 0 && publishAt < ids.length - 1 ? `stages[${publishAt + 1}]` : "stages";
    problems.add(after, "`submit` and `publish` end the path, in that order");
  }
  for (const id of ["submit", "publish"] as const) {
    const index = ids.indexOf(id);
    if (index < 0) continue;
    const entry = value[index] as Record<string, unknown>;
    const at = `stages[${index}]`;
    const skill = mateStageSkill(id)!;
    if (entry.optional === true) problems.add(keyAt(at, "optional"), `\`${id}\` is never optional`);
    if (id === "submit" && entry.artifact === undefined) {
      problems.add(
        keyAt(at, "artifact"),
        "a custom workflow names the artifact type submit handles: a declared one or `openspec`",
      );
    }
    const steps = Array.isArray(entry.steps) ? entry.steps : [];
    if (!steps.some((step) => isRecord(step) && step.skill === skill)) {
      problems.add(keyAt(at, "steps"), `the chain needs \`{ skill: ${skill} }\``);
    }
  }
  return result;
}

/** Parses and validates the declaration text; `file` is its companion-relative path. */
export function parseWorkflow(source: string, file: string = WORKFLOW_FILE): WorkflowVerdict {
  const problems = new Problems();
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    strict: true,
  });
  for (const error of document.errors) problems.add("", error.message);
  if (problems.list.length > 0) return { ok: false, file, problems: problems.list };
  findAnchors(document.contents, "", problems);
  if (problems.list.length > 0) return { ok: false, file, problems: problems.list };

  const value: unknown = document.toJS();
  if (!isRecord(value)) {
    problems.add("", "the declaration is a mapping with `version: 1`");
    return { ok: false, file, problems: problems.list };
  }
  const { version } = value;
  if (version === undefined) {
    problems.add("version", "`version: 1` is required");
  } else if (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version > WORKFLOW_VERSION
  ) {
    problems.add("version", `version ${version} needs a newer Mate to read it`);
    return { ok: false, file, problems: problems.list };
  } else if (version !== WORKFLOW_VERSION) {
    problems.add("version", "`version` must be 1");
  }
  problems.unknownKeys(value, ["version", "stages", "artifacts"], "");

  const artifacts = parseArtifacts(value.artifacts, problems);
  const parsed = parseStages(value.stages, artifacts, problems);
  if (problems.list.length > 0) return { ok: false, file, problems: problems.list };
  return { ok: true, workflow: { file, ...parsed, artifacts, warnings: [] } };
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Companion directories a declared skill is looked up in. */
const SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

/** Declared skills with no `SKILL.md` in the companion; they may still come from the runtime. */
async function missingSkills(companionPath: string, workflow: Workflow): Promise<string[]> {
  const skills = new Set(
    workflow.stages.flatMap((stage) =>
      stage.kind === "skill" && stage.source === "declared"
        ? // Mate installs its own stage skills.
          stage.steps.filter((step) => !step.own).map((step) => step.skill)
        : [],
    ),
  );
  const found = await Promise.all(
    [...skills].map(async (skill) => {
      const present = await Promise.all(
        SKILL_ROOTS.map((root) => isFile(path.join(companionPath, root, skill, "SKILL.md"))),
      );
      return present.some(Boolean) ? null : skill;
    }),
  );
  return found.filter((skill): skill is string => skill !== null);
}

/**
 * The companion's workflow: the default without a declaration, the declared one when it is
 * valid, its problems otherwise. A companion's own skill is never read for a Mate line: its
 * steps are reported through session guidance, or count once a later step is recorded.
 */
export async function loadWorkflow(companionPath: string): Promise<WorkflowVerdict> {
  let source: string;
  try {
    source = await fs.readFile(path.join(companionPath, ...WORKFLOW_FILE.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, workflow: defaultWorkflow() };
    }
    throw error;
  }
  const verdict = parseWorkflow(source);
  if (!verdict.ok) return verdict;
  const warnings = (await missingSkills(companionPath, verdict.workflow)).map(
    (skill) =>
      `${skill} is not in the companion's skills; the stage runs it only when the Agent Runtime has it`,
  );
  return { ok: true, workflow: { ...verdict.workflow, warnings } };
}

/**
 * {@link loadWorkflow} without the missing-skill warnings, for a reader that cannot wait: session
 * guidance and the session banner. A file that cannot be read counts as invalid.
 */
export function readWorkflow(companionPath: string): WorkflowVerdict {
  let source: string;
  try {
    source = readFileSync(path.join(companionPath, ...WORKFLOW_FILE.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, workflow: defaultWorkflow() };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, file: WORKFLOW_FILE, problems: [{ path: "", message }] };
  }
  return parseWorkflow(source);
}
