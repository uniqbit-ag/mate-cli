import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

/**
 * Inline Area binding a requirement carries in a spec body. Anchored to the
 * start of its own line, which is where the marker is written: a spec that
 * merely mentions the marker inside prose or a code span binds no Area by
 * talking about one.
 */
const INLINE_AREA = /^\*\*Area:\*\*[ \t]*`([^`\n]+)`/gm;

function frontmatterAreas(content: string): string[] {
  if (!content.startsWith("---")) return [];
  const end = content.indexOf("\n---", 3);
  if (end < 0) return [];
  let parsed: unknown;
  try {
    parsed = parse(content.slice(3, end));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const document = parsed as { areas?: unknown; scopes?: unknown };
  const areas = Array.isArray(document.areas)
    ? document.areas.filter((entry): entry is string => typeof entry === "string")
    : [];
  const scoped = Array.isArray(document.scopes)
    ? document.scopes
        .map((entry) =>
          entry && typeof entry === "object" ? (entry as { area?: unknown }).area : undefined,
        )
        .filter((area): area is string => typeof area === "string")
    : [];
  return [...areas, ...scoped];
}

/**
 * Areas one spec binds. No OpenSpec JSON command reports them in bulk — a
 * per-spec `show --json` would cost one process per spec — so the resolved
 * spec document is read directly: frontmatter `areas`/`scopes` unioned with the
 * inline `**Area:**` bindings its requirements carry.
 */
export async function readSpecAreas(
  specsRoot: string,
  specId: string,
  readFile: (filePath: string) => Promise<string> = (filePath) => fs.readFile(filePath, "utf8"),
): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(path.join(specsRoot, specId, "spec.md"));
  } catch {
    return [];
  }

  const areas = new Set(
    frontmatterAreas(content)
      .map((area) => area.trim())
      .filter(Boolean),
  );
  for (const match of content.matchAll(INLINE_AREA)) {
    const area = match[1]?.trim();
    if (area) areas.add(area);
  }
  return [...areas].toSorted((a, b) => a.localeCompare(b));
}
