import { parse } from "yaml";

/** A leading `---` block; group 1 is its YAML, the match ends after the closing line. */
export const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A Markdown file's leading YAML frontmatter; null when absent, malformed, or not a mapping. */
export function readFrontmatter(source: string): Record<string, unknown> | null {
  const header = FRONTMATTER_PATTERN.exec(source)?.[1];
  if (header === undefined) return null;
  try {
    const parsed: unknown = parse(header);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
