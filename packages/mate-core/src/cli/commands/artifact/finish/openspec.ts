import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import { runIndexCapCommand } from "../../cap/index-cmd";
import { discoverArchives, SPECS_RELATIVE_DIR, unattributedSpecs } from "../pending/discovery";
import type { ArtifactFinisher, FinishContext, Produced, ResolveResult } from "./finisher";
import type { GitOps } from "./git";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** A dated archive anchor; group 1 is the change name the archive was created from. */
const ANCHOR_PATTERN = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

/**
 * The publication commit's exact scope. The active-change path is included only when it
 * is gone from disk — that absence IS the deletion archiving produced. A path that still
 * exists belongs to a same-name change started after archiving, which is unrelated work.
 */
async function commitPathsForArchive(
  companionPath: string,
  name: string,
  anchorName: string,
): Promise<string[]> {
  const archiveRelative = path.posix.join("openspec", "changes", "archive", anchorName);
  const activeRelative = path.posix.join("openspec", "changes", name);
  const deltaSpecsDir = path.join(companionPath, archiveRelative, "specs");
  const canonicalSpecs: string[] = [];
  const collectDeltaSpecFiles = async (directory: string, relative = ""): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await collectDeltaSpecFiles(path.join(directory, entry.name), entryRelative);
      } else if (entry.isFile()) {
        canonicalSpecs.push(path.posix.join("openspec", "specs", entryRelative));
      }
    }
  };
  try {
    await collectDeltaSpecFiles(deltaSpecsDir);
  } catch {
    // Changes without delta specs still commit their active deletion and archive.
  }
  return [
    ...((await pathExists(path.join(companionPath, activeRelative))) ? [] : [activeRelative]),
    archiveRelative,
    ...canonicalSpecs.toSorted(),
  ];
}

const BOM = "﻿";

interface ScopePair {
  repository: string;
  area: string;
}

type ProjectionResult =
  | { ok: true; repository: string; areas: string[] }
  | { ok: false; reason: string };

function parseDeltaScopes(source: string): ScopePair[] {
  const text = source.startsWith(BOM) ? source.slice(BOM.length) : source;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return [];

  try {
    const parsed = parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const scopes = (parsed as Record<string, unknown>).scopes;
    if (!Array.isArray(scopes)) return [];
    return scopes.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const pair = entry as Record<string, unknown>;
      return typeof pair.repository === "string" && typeof pair.area === "string"
        ? [{ repository: pair.repository, area: pair.area }]
        : [];
    });
  } catch {
    return [];
  }
}

function projectDeltaScopes(scopes: ScopePair[]): ProjectionResult {
  if (scopes.length === 0) return { ok: false, reason: "delta declares no scopes entries" };
  const repositories = [...new Set(scopes.map((entry) => entry.repository))];
  if (repositories.length > 1) {
    return {
      ok: false,
      reason: `delta names ${repositories.length} repositories (${repositories.join(", ")}); a spec names exactly one`,
    };
  }
  return {
    ok: true,
    repository: repositories[0],
    areas: [...new Set(scopes.map((entry) => entry.area))],
  };
}

async function archivedChangeUsesMateSchema(
  companionPath: string,
  anchorName: string,
): Promise<boolean> {
  try {
    const metadataPath = path.join(
      companionPath,
      "openspec",
      "changes",
      "archive",
      anchorName,
      ".openspec.yaml",
    );
    const parsed = parse(await fs.readFile(metadataPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    const schema = (parsed as Record<string, unknown>).schema;
    return typeof schema === "string" && ["mate-v1", "mate-minimal"].includes(schema.trim());
  } catch {
    return false;
  }
}

/** Scope keys are omitted when the delta had none — a partial block beats no frontmatter. */
function renderCanonicalFrontmatter(
  capability: string,
  scope: { repository: string; areas: string[] } | null,
): string {
  return [
    "---",
    "type: spec",
    `capability: ${capability}`,
    ...(scope ? [`repository: ${scope.repository}`, `areas: [${scope.areas.join(", ")}]`] : []),
    "tags: [openspec/spec]",
    "---",
    "",
    "",
  ].join("\n");
}

/**
 * Repairs `openspec archive` output: prepends canonical frontmatter to main specs the
 * archive run created bare. Publish does not archive, so this runs the first time publish
 * resolves that archive, however the archive was made.
 *
 * `openspec archive` rebuilds a brand-new main spec from a skeleton with no frontmatter slot,
 * so scope metadata dies exactly once, at spec birth; existing specs keep theirs because only
 * requirement blocks are spliced. Idempotent, and best-effort by design — the archive is
 * durable input, so a failure here warns rather than refusing the publication.
 */
async function reconcileMainSpecFrontmatter(
  companionPath: string,
  anchorName: string,
): Promise<string[]> {
  if (!(await archivedChangeUsesMateSchema(companionPath, anchorName))) return [];

  const deltaSpecsDir = path.join(
    companionPath,
    "openspec",
    "changes",
    "archive",
    anchorName,
    "specs",
  );
  const reconciled: string[] = [];

  const walk = async (directory: string, relative = ""): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), entryRelative);
        continue;
      }
      if (!entry.isFile() || entry.name !== "spec.md") continue;

      const capability = path.posix.dirname(entryRelative);
      if (capability === ".") continue;
      const canonicalRelative = path.posix.join("openspec", "specs", entryRelative);
      const canonicalPath = path.join(companionPath, canonicalRelative);

      try {
        const canonical = await fs.readFile(canonicalPath, "utf8");
        if (canonical.replace(BOM, "").startsWith("---")) continue;

        const deltaSource = await fs.readFile(path.join(directory, entry.name), "utf8");
        const scopes = parseDeltaScopes(deltaSource);
        const projected = projectDeltaScopes(scopes);

        /** Multi-repository is invalid input, so skip; absent scopes still earn a partial block. */
        if (!projected.ok && scopes.length > 0) {
          process.stderr.write(
            `mate: skipped frontmatter for ${canonicalRelative}: ${projected.reason}\n`,
          );
          continue;
        }
        const head = renderCanonicalFrontmatter(
          capability,
          projected.ok ? { repository: projected.repository, areas: projected.areas } : null,
        );
        await fs.writeFile(canonicalPath, head + canonical.replace(BOM, ""), "utf8");
        reconciled.push(canonicalRelative);
      } catch (error) {
        process.stderr.write(
          `mate: could not reconcile frontmatter for ${canonicalRelative}: ${String(error)}\n`,
        );
      }
    }
  };

  await walk(deltaSpecsDir);
  return reconciled;
}

async function capSync(context: FinishContext): Promise<boolean> {
  const previous = process.exitCode;
  process.exitCode = 0;
  const previousEnv = new Map(
    ["MATE_ARTIFACT_PATH", "MATE_REPO_PATH", "MATE_REPO_ID"].map((key) => [key, process.env[key]]),
  );

  // Pass both sides of the companion/working-repo boundary explicitly. Capability
  // commands resolve their own target paths and do not need a cwd switch.
  process.env.MATE_ARTIFACT_PATH = context.companionPath;
  if (context.repository) {
    process.env.MATE_REPO_PATH = context.repository.path;
    process.env.MATE_REPO_ID = context.repository.id;
  }
  try {
    await runIndexCapCommand([]);
    return process.exitCode === 0;
  } catch (error) {
    process.stderr.write(`mate: capability sync failed: ${String(error)}\n`);
    return false;
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = previous;
  }
}

async function resolved(
  companionPath: string,
  name: string,
  anchorName: string,
): Promise<ResolveResult> {
  const commitPaths = await commitPathsForArchive(companionPath, name, anchorName);
  await reconcileMainSpecFrontmatter(companionPath, anchorName);
  return { ok: true, resolved: { anchorName, commitPaths } };
}

/** Tag namespace segregating spec publications from dated change anchors. */
export const SPEC_TAG_NAMESPACE = "openspec/specs";
/** Spec ids named individually before the remainder collapses into a count. */
const SPEC_LABEL_LIMIT = 3;

/** `openspec/specs/<id>/...` -> `<id>`: the capability directory is the spec's identity. */
function specId(candidate: string): string {
  return candidate.slice(`${SPECS_RELATIVE_DIR}/`.length).split("/")[0];
}

/** Unique ids in path order, so anchor and subject always name the same specs. */
function specIds(paths: string[]): string[] {
  return [...new Set(paths.map(specId))];
}

/**
 * The spec ids a publication ships, as `<a>+<b>+<c>+<n>-more`. A dated anchor alone
 * says when a publication ran but never what it shipped; naming the specs makes the tag
 * readable without checking out its commit, and the cap keeps a wide sync from growing
 * an unbounded ref name. Empty for an empty publication, which then anchors on its date.
 */
function specLabel(paths: string[]): string {
  const ids = specIds(paths);
  const named = ids.slice(0, SPEC_LABEL_LIMIT);
  const remaining = ids.length - named.length;
  return [...named, ...(remaining > 0 ? [`${remaining}-more`] : [])].join("+");
}

/** Commit subject for a spec publication; it belongs to no change, so it names specs, never an anchor. */
export function specCommitSubject(paths: string[]): string {
  const ids = specIds(paths);
  const named = ids.slice(0, SPEC_LABEL_LIMIT);
  const remaining = ids.length - named.length;
  if (named.length === 0) return "chore(openspec): sync canonical specs";
  const listed = remaining > 0 ? `${named.join(", ")} and ${remaining} more` : named.join(", ");
  return `chore(openspec): sync canonical specs (${listed})`;
}

/** Working-tree reads a spec publication needs; nothing here mutates the repository. */
export type SpecDriftGit = Pick<GitOps, "changedPaths" | "changedPathKinds">;

export type DriftResolution = { ok: true; paths: string[] } | { ok: false; message: string };

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local calendar date as `YYYY-MM-DD`. */
function calendarDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function withoutTrailingSlash(candidate: string): string {
  return candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
}

/**
 * Canonical specs that drifted: uncommitted under `openspec/specs/` and claimed by no
 * pending change. Delegates to the same discovery `mate artifact pending` reports from,
 * so the two commands can never disagree about what is drifted. Only paths and
 * working-tree status are read — never spec or archived file content.
 *
 * `requested` narrows the set rather than being trusted: a path that is not drifted, or
 * sits outside the canonical spec tree, refuses the whole invocation instead of
 * publishing a surprising subset.
 */
export async function resolveDriftedSpecs(
  companionPath: string,
  git: SpecDriftGit,
  requested: string[] = [],
): Promise<DriftResolution> {
  const changed = await git.changedPaths();
  const changeKinds = (await git.changedPathKinds?.()) ?? {};
  const archives = await discoverArchives(companionPath, changed, changeKinds);
  const drifted = (await unattributedSpecs(companionPath, changed, archives, changeKinds)).map(
    (spec) => spec.path,
  );

  if (requested.length === 0) return { ok: true, paths: drifted };

  const normalized = requested.map(withoutTrailingSlash);
  const outside = normalized.filter((candidate) => !candidate.startsWith(`${SPECS_RELATIVE_DIR}/`));
  if (outside.length > 0) {
    return {
      ok: false,
      message: `mate: not a canonical spec: ${outside.join(", ")}. Only specs under ${SPECS_RELATIVE_DIR}/ are spec publication targets.`,
    };
  }
  const driftedPaths = new Set(drifted);
  const notDrifted = normalized.filter((candidate) => !driftedPaths.has(candidate));
  if (notDrifted.length > 0) {
    return {
      ok: false,
      message: `mate: not drifted: ${notDrifted.join(", ")}. Run \`mate artifact pending\` to see which canonical specs are uncommitted and unaccounted for.`,
    };
  }
  return { ok: true, paths: normalized.toSorted() };
}

/**
 * The spec publication finisher. Its target is already resolved by
 * {@link resolveDriftedSpecs}, because an empty drift set is a clean no-op rather than a
 * refusal and the engine's resolve step can only succeed or fail.
 *
 * This is the one publication unit that computes its own anchor: it has no archive
 * directory to read one from. The anchor is the calendar date plus the {@link specLabel}
 * of the specs it ships. The segregated {@link SPEC_TAG_NAMESPACE} keeps that computed
 * anchor out of the dated change anchors, which still never compute one.
 */
export function openspecSpecsFinisher(
  contextOrPath: FinishContext | string,
  paths: string[],
  now: () => Date = () => new Date(),
): ArtifactFinisher {
  const context: FinishContext =
    typeof contextOrPath === "string"
      ? { companionPath: contextOrPath, repositoryId: "" }
      : contextOrPath;

  return {
    type: "openspec",
    disabledReason: "mate: the openspec capability must be enabled to run artifact publish.",
    isEnabled(capabilities) {
      return hasOpenspecCapability(capabilities);
    },
    async resolve() {
      const label = specLabel(paths);
      const publication: Produced = {
        anchorName: `${calendarDate(now())}${label === "" ? "" : `-${label}`}`,
        commitPaths: paths,
        tagNamespace: SPEC_TAG_NAMESPACE,
        commitSubject: specCommitSubject(paths),
        tagCollision: "suffix",
      };
      return { ok: true, resolved: publication };
    },
    capSync() {
      return capSync(context);
    },
  };
}

/**
 * The openspec artifact finisher: resolution of an already-archived change, an
 * openspec-scoped cap sync, and a commit scoped to `openspec/`. Validation and
 * completeness belong to `openspec archive`, which performs both and is the only step
 * that can — an archived change is neither validatable nor listed as active.
 *
 * Resolution reads the dated `openspec/changes/archive/` directory names openspec
 * actually created, so a change publication's tag is never a computed date and archived
 * prose is never read. Spec publications are the documented exception: having no archive
 * directory to read a date from, {@link openspecSpecsFinisher} computes one, in its own
 * segregated tag namespace.
 */
export function openspecFinisher(contextOrPath: FinishContext | string): ArtifactFinisher {
  const context: FinishContext =
    typeof contextOrPath === "string"
      ? { companionPath: contextOrPath, repositoryId: "" }
      : contextOrPath;
  const companionPath = context.companionPath;

  return {
    type: "openspec",
    disabledReason: "mate: the openspec capability must be enabled to run artifact publish.",
    isEnabled(capabilities) {
      return hasOpenspecCapability(capabilities);
    },
    async resolve(target) {
      const archiveRoot = path.join(companionPath, "openspec", "changes", "archive");
      const anchor = ANCHOR_PATTERN.exec(target);

      /** A dated anchor names exactly one directory; no name matching can widen it. */
      if (anchor) {
        if (!(await pathExists(path.join(archiveRoot, target)))) {
          return {
            ok: false,
            message: `mate: no archive at openspec/changes/archive/${target}. Archive the change first with \`openspec archive ${anchor[2]}\`.`,
          };
        }
        return resolved(companionPath, anchor[2], target);
      }

      const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(target)}$`);
      let matches: string[] = [];
      try {
        const entries = await fs.readdir(archiveRoot, { withFileTypes: true });
        matches = [];
        for (const entry of entries) {
          if (entry.isDirectory() && pattern.test(entry.name)) matches.push(entry.name);
        }
        matches = matches.toSorted();
      } catch {
        /** No archive directory at all: nothing can match. */
      }

      if (matches.length === 0) {
        const active = await pathExists(path.join(companionPath, "openspec", "changes", target));
        return {
          ok: false,
          message: active
            ? `mate: ${target} is still active and cannot be published. Run \`openspec archive ${target}\` first; publish only publishes archived changes.`
            : `mate: no archived change matches "${target}". Archive it first with \`openspec archive ${target}\`, or pass a dated archive anchor.`,
        };
      }
      /** Two archives, no tiebreaker: picking one would publish an anchor nobody chose. */
      if (matches.length > 1) {
        return {
          ok: false,
          message: `mate: "${target}" matches ${matches.length} archives (${matches.join(", ")}). Pass one anchor explicitly.`,
        };
      }
      return resolved(companionPath, target, matches[0]);
    },
    capSync() {
      return capSync(context);
    },
  };
}
