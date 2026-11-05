import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import {
  isPublishable,
  legacyDeliveryWarning,
  readDeliveryState,
} from "../../../../lib/delivery/record";
import {
  ARCHIVE_RELATIVE_DIR,
  archiveAnchors,
  archiveDirOf,
  CHANGES_RELATIVE_DIR,
  deltaSpecs,
  isChangeName,
  parseAnchor,
  SPECS_RELATIVE_DIR,
} from "../../../../lib/change-layout";
import { FRONTMATTER_PATTERN } from "../../../../lib/frontmatter";
import { pathIsDirectory } from "../../../../lib/fs-utils";
import {
  BOM,
  DELTA_COMMENT_PATTERN,
  parseScopes,
  type ScopePair,
} from "../../../../lib/openspec-scopes";
import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import { runIndexCapCommand } from "../../cap/index-cmd";
import {
  canonicalSpecsFor,
  discoverArchives,
  pendingArchives,
  unattributedSpecs,
  type ArchiveEntry,
} from "../pending/discovery";
import type { ArtifactFinisher, FinishContext, Produced, ResolveResult } from "./finisher";
import type { GitOps } from "./git";

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

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
  const archiveRelative = `${ARCHIVE_RELATIVE_DIR}/${anchorName}`;
  const activeRelative = `${CHANGES_RELATIVE_DIR}/${name}`;
  // Changes without delta specs still commit their active deletion and archive.
  const canonicalSpecs = await deltaSpecs(path.join(companionPath, archiveRelative));
  return [
    ...((await pathExists(path.join(companionPath, activeRelative))) ? [] : [activeRelative]),
    archiveRelative,
    ...canonicalSpecs.map((spec) => spec.canonical),
  ];
}

type ProjectionResult =
  | { ok: true; repository: string; areas: string[] }
  | { ok: false; reason: string };

/** The opening line of a `mate:delta` comment, closed or not. */
const DELTA_COMMENT_OPENER = /^<!--[ \t]*mate:delta/;

const DELTA_TAGS = new Set(["openspec/change", "openspec/delta"]);

/**
 * A header an agent copied from a delta: it declares `type: delta-spec`, carries a
 * `change` key, or a delta tag. A nested `scopes` key alone does not count, since
 * legacy canonical specs carry one.
 */
function isDeltaShapedFrontmatter(yamlSource: string): boolean {
  try {
    const parsed = parse(yamlSource) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const header = parsed as Record<string, unknown>;
    if (header.type === "delta-spec" || "change" in header) return true;
    const tags = Array.isArray(header.tags) ? header.tags : [header.tags];
    return tags.some((tag) => typeof tag === "string" && DELTA_TAGS.has(tag));
  } catch {
    return false;
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

/**
 * The block through its closing line. Scope keys are omitted when the delta had
 * none — a partial block beats no frontmatter.
 */
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
  ].join("\n");
}

/**
 * Repairs `openspec archive` output: prepends canonical frontmatter to main specs the
 * archive run created bare, and replaces a delta-shaped header or `mate:delta` comment an
 * agent copied onto one.
 * Publish does not archive, so this runs the first time publish resolves that archive,
 * however the archive was made.
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

  const archiveDir = path.join(archiveDirOf(companionPath), anchorName);
  const reconciled: string[] = [];

  for (const { file, canonical: canonicalRelative, capability } of await deltaSpecs(archiveDir)) {
    if (capability === null) continue;
    const canonicalPath = path.join(companionPath, canonicalRelative);

    try {
      const canonical = (await fs.readFile(canonicalPath, "utf8")).replace(BOM, "");
      /** The body that follows the written block: the whole file, or what trails a delta-shaped header. */
      let body = `\n${canonical}`;
      if (DELTA_COMMENT_OPENER.test(canonical)) {
        const header = DELTA_COMMENT_PATTERN.exec(canonical);
        if (!header) continue;
        body = canonical.slice(header[0].length);
      } else if (canonical.startsWith("---")) {
        const header = FRONTMATTER_PATTERN.exec(canonical);
        if (!header || !isDeltaShapedFrontmatter(header[1])) continue;
        body = canonical.slice(header[0].length);
      }

      const deltaSource = await fs.readFile(path.join(archiveDir, "specs", file), "utf8");
      const scopes = parseScopes(deltaSource);
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
      await fs.writeFile(canonicalPath, head + body, "utf8");
      reconciled.push(canonicalRelative);
    } catch (error) {
      process.stderr.write(
        `mate: could not reconcile frontmatter for ${canonicalRelative}: ${String(error)}\n`,
      );
    }
  }
  return reconciled;
}

async function capSync(context: FinishContext): Promise<boolean> {
  // Without a linked Working Repository, as in the appliance's companion clone, there is
  // no source to re-index; the capability commands would refuse for want of one.
  if (!context.repository) return true;
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

/** Why an archive's delivery keeps it unpublished, or null when it may be published. */
async function deliveryHold(companionPath: string, anchorName: string): Promise<string | null> {
  const delivery = await readDeliveryState(path.join(archiveDirOf(companionPath), anchorName));
  if (delivery.error) return `mate: refusing to publish ${anchorName}: ${delivery.error}`;
  if (isPublishable(delivery.status)) return null;
  const waiting = delivery.unsettled.length > 0 ? ` (${delivery.unsettled.join(", ")})` : "";
  // The dated anchor, since a bare name resolves to an active change or the newest archive.
  const [missing] = delivery.missing;
  const remedy = missing
    ? `Its scopes name ${delivery.missing.join(", ")} without a delivery; record each with \`mate artifact link ${anchorName} --repository ${missing} --branch <branch>\` or \`--not-applicable <reason>\`, then publish.`
    : `Record or settle it with \`mate artifact link ${anchorName}\`, then publish.`;
  return `mate: ${anchorName} is held back: its delivery is ${delivery.status}${waiting}. ${remedy}`;
}

/**
 * Per-run memo of each archive's canonical specs, delivery hold, and the pending archives.
 * None changes the answer while a run publishes: a published archive was not held, so it
 * never held another back. `publish --all` thus reads each archive and Git status once.
 */
export interface PublicationHoldCache {
  specs: Map<string, Promise<string[]>>;
  holds: Map<string, Promise<string | null>>;
  pending?: Promise<ArchiveEntry[]>;
}

export function publicationHoldCache(): PublicationHoldCache {
  return { specs: new Map(), holds: new Map() };
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let value = cache.get(key);
  if (!value) {
    value = load();
    cache.set(key, value);
  }
  return value;
}

/**
 * The merge gate, whoever asks: an archive whose delivery is not settled stays unpublished,
 * and so does one sharing a canonical spec with a pending held-back archive, since its
 * commit would carry that archive's unmerged requirements along. Null when publishable.
 */
export async function publicationHold(
  companionPath: string,
  anchorName: string,
  changedPaths?: () => Promise<string[]>,
  cache: PublicationHoldCache = publicationHoldCache(),
): Promise<string | null> {
  const holdOf = (anchor: string): Promise<string | null> =>
    memo(cache.holds, anchor, () => deliveryHold(companionPath, anchor));
  const specsOf = (anchor: string): Promise<string[]> =>
    memo(cache.specs, anchor, () => canonicalSpecsFor(companionPath, anchor));

  const own = await holdOf(anchorName);
  if (own || !changedPaths) return own;

  const specs = new Set(await specsOf(anchorName));
  if (specs.size === 0) return null;
  cache.pending ??= changedPaths().then(async (changed) =>
    pendingArchives(await discoverArchives(companionPath, changed)),
  );
  const others = (await cache.pending).filter((entry) => entry.anchor !== anchorName);
  for (const other of others) {
    const shared = (await specsOf(other.anchor)).filter((spec) => specs.has(spec));
    if (shared.length === 0) continue;
    if ((await holdOf(other.anchor)) === null) continue;
    return `mate: ${anchorName} is held back: ${shared.join(", ")} also carries edits from ${other.anchor}, which is not publishable yet. Publish it after ${other.anchor} settles.`;
  }
  return null;
}

async function resolved(
  context: FinishContext,
  name: string,
  anchorName: string,
): Promise<ResolveResult> {
  const { companionPath } = context;
  const hold = await publicationHold(
    companionPath,
    anchorName,
    context.changedPaths,
    context.holdCache,
  );
  if (hold) return { ok: false, message: hold };
  const delivery = await readDeliveryState(path.join(archiveDirOf(companionPath), anchorName));
  const commitPaths = await commitPathsForArchive(companionPath, name, anchorName);
  await reconcileMainSpecFrontmatter(companionPath, anchorName);
  return {
    ok: true,
    resolved: {
      anchorName,
      commitPaths,
      ...(delivery.status === "legacy" ? { warning: legacyDeliveryWarning(anchorName) } : {}),
    },
  };
}

/** Tag namespace segregating spec publications from dated change anchors. */
const SPEC_TAG_NAMESPACE = "openspec/specs";
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
function specCommitSubject(paths: string[]): string {
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
  const driftedPaths = new Set(drifted.map(withoutTrailingSlash));
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
      /** A path-like target names no archive; refuse before touching the filesystem. */
      if (!isChangeName(target)) {
        return {
          ok: false,
          message: `mate: no archived change matches "${target}". Pass a change name or a dated archive anchor.`,
        };
      }
      const anchor = parseAnchor(target);

      /** A dated anchor names exactly one directory; no name matching can widen it. */
      if (anchor) {
        if (!(await pathIsDirectory(path.join(archiveDirOf(companionPath), target)))) {
          return {
            ok: false,
            message: `mate: no archive at ${ARCHIVE_RELATIVE_DIR}/${target}. Archive the change first with \`openspec archive ${anchor.name}\`.`,
          };
        }
        return resolved(context, anchor.name, target);
      }

      const matches = await archiveAnchors(companionPath, target);

      if (matches.length === 0) {
        const active = await pathExists(path.join(companionPath, CHANGES_RELATIVE_DIR, target));
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
      return resolved(context, target, matches[0]);
    },
    capSync() {
      return capSync(context);
    },
  };
}
