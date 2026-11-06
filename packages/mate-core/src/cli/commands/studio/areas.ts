import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import type { StudioSpecScope } from "./payload";

/**
 * Inline Area binding a requirement carries in a spec body. Anchored to the
 * start of its own line, which is where the marker is written: a spec that
 * merely mentions the marker inside prose or a code span binds no Area by
 * talking about one. Captures the comma-separated backticked list right after
 * the marker; a code span later on the line is prose, not an Area.
 */
const INLINE_AREA_LIST = /^\*\*Area:\*\*[ \t]*((?:`[^`\n]+`(?:[ \t]*,[ \t]*)?)+)/gm;
const BACKTICKED = /`([^`\n]+)`/g;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

interface Frontmatter {
  repository?: string;
  areas: string[];
  scopes: StudioSpecScope[];
}

function readFrontmatter(content: string): Frontmatter {
  const empty: Frontmatter = { areas: [], scopes: [] };
  if (!content.startsWith("---")) return empty;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return empty;
  let parsed: unknown;
  try {
    parsed = parse(content.slice(3, end));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;

  const document = parsed as { repository?: unknown; areas?: unknown; scopes?: unknown };
  const areas = Array.isArray(document.areas)
    ? document.areas.map(text).filter((area): area is string => area !== undefined)
    : [];
  const scopes = Array.isArray(document.scopes)
    ? document.scopes.flatMap((entry): StudioSpecScope[] => {
        if (!entry || typeof entry !== "object") return [];
        const { repository, area } = entry as { repository?: unknown; area?: unknown };
        const scope = scopeOf(text(repository), text(area));
        return scope ? [scope] : [];
      })
    : [];
  const repository = text(document.repository);
  return { ...(repository ? { repository } : {}), areas, scopes };
}

function scopeOf(repository?: string, area?: string): StudioSpecScope | undefined {
  if (!repository && !area) return undefined;
  return { ...(repository ? { repository } : {}), ...(area ? { area } : {}) };
}

function inlineAreas(content: string): string[] {
  const areas: string[] = [];
  for (const line of content.matchAll(INLINE_AREA_LIST)) {
    for (const value of (line[1] ?? "").matchAll(BACKTICKED)) {
      const area = value[1]?.trim();
      if (area) areas.push(area);
    }
  }
  return areas;
}

/** Repository first, specs without one last; then Area, a repository-only pair first. */
function compareScopes(left: StudioSpecScope, right: StudioSpecScope): number {
  if (left.repository !== right.repository) {
    if (left.repository === undefined) return 1;
    if (right.repository === undefined) return -1;
    return left.repository.localeCompare(right.repository);
  }
  return (left.area ?? "").localeCompare(right.area ?? "");
}

/**
 * Pairs deduplicated and sorted. A repository-only pair is dropped when another
 * pair names an Area of that repository.
 */
function normalizeScopes(scopes: StudioSpecScope[]): StudioSpecScope[] {
  const withArea = new Set(scopes.flatMap((scope) => (scope.area ? [scope.repository ?? ""] : [])));
  const unique = new Map<string, StudioSpecScope>();
  for (const scope of scopes) {
    if (!scope.area && withArea.has(scope.repository ?? "")) continue;
    unique.set(`${scope.repository ?? ""}\n${scope.area ?? ""}`, scope);
  }
  return [...unique.values()].toSorted(compareScopes);
}

/**
 * Repository/Area pairs one spec binds. No OpenSpec JSON command reports them
 * in bulk — a per-spec `show --json` would cost one process per spec — so the
 * resolved spec document is read directly: the top-level `repository` with each
 * `areas` entry, each `scopes` entry, and the inline `**Area:**` bindings its
 * requirements carry. A top-level or inline Area pairs with the top-level
 * repository, else the only repository the scopes name. Repositories named by a
 * linked registry ID are read as its `org/repository` identity first, so one
 * repository named both ways still counts once.
 */
export async function readSpecScopes(
  specsRoot: string,
  specId: string,
  readFile: (filePath: string) => Promise<string> = (filePath) => fs.readFile(filePath, "utf8"),
  aliases: ReadonlyMap<string, string> = new Map(),
): Promise<StudioSpecScope[]> {
  let content: string;
  try {
    content = await readFile(path.join(specsRoot, specId, "spec.md"));
  } catch {
    return [];
  }

  const frontmatter = readFrontmatter(content);
  const identity = (repository?: string) =>
    repository === undefined ? undefined : (aliases.get(repository) ?? repository);
  const repository = identity(frontmatter.repository);
  const scopes = frontmatter.scopes.map((scope) =>
    scope.repository ? { ...scope, repository: identity(scope.repository) } : scope,
  );
  const scopedRepositories = [...new Set(scopes.flatMap((scope) => scope.repository ?? []))];
  const areaRepository =
    repository ?? (scopedRepositories.length === 1 ? scopedRepositories[0] : undefined);

  const candidates: StudioSpecScope[] = [
    ...(frontmatter.areas.length > 0
      ? frontmatter.areas.map((area) => scopeOf(areaRepository, area))
      : [scopeOf(repository)]),
    ...scopes,
    ...inlineAreas(content).map((area) => scopeOf(areaRepository, area)),
  ].filter((scope): scope is StudioSpecScope => scope !== undefined);

  return normalizeScopes(candidates);
}
