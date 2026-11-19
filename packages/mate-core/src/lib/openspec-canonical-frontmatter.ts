// oxlint-disable no-await-in-loop -- one canonical spec at a time
import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { archiveDirOf, deltaSpecs } from "./change-layout";
import { FRONTMATTER_PATTERN } from "./frontmatter";
import { BOM, DELTA_COMMENT_PATTERN, parseScopes, type ScopePair } from "./openspec-scopes";

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
export async function reconcileMainSpecFrontmatter(
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
