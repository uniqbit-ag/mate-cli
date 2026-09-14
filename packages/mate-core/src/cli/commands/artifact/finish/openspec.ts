import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { hasOpenspecCapability } from "../../../../lib/orchestrator/capabilities";
import { runIndexCapCommand } from "../../cap/index-cmd";
import type { ArtifactFinisher, FinishContext, ResolveResult } from "./finisher";

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

/**
 * The openspec artifact finisher: resolution of an already-archived change, an
 * openspec-scoped cap sync, and a commit scoped to `openspec/`. Validation and
 * completeness belong to `openspec archive`, which performs both and is the only step
 * that can — an archived change is neither validatable nor listed as active.
 *
 * Resolution reads the dated `openspec/changes/archive/` directory names openspec
 * actually created, so the tag is never a computed date and archived prose is never read.
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
