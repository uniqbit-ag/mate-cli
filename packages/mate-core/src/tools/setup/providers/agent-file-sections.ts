// Shared markdown section primitives for agent instruction files (CLAUDE.md,
// AGENTS.md), plus a thin file-level wrapper for stripping sections in place.

import fs from "node:fs/promises";

export interface RemoveHeadingSectionOptions {
  /** Matches the heading line that opens the section to remove. */
  isHeading(line: string): boolean;
  /** Exact lines (e.g. HTML comment markers) stripped wherever they appear. */
  markerLines?: string[];
}

/**
 * Remove a heading-delimited section (heading line up to the next `#`/`##`
 * heading or EOF), collapsing leftover blank runs. Marker lines are stripped
 * even when no section heading is present.
 */
export function removeHeadingSection(
  content: string,
  options: RemoveHeadingSectionOptions,
): string {
  const markerLines = new Set(options.markerLines ?? []);
  const normalizedLines = content.split("\n").filter((line) => !markerLines.has(line));

  const start = normalizedLines.findIndex(options.isHeading);
  if (start === -1) {
    const strippedMarkersOnly = normalizedLines.join("\n");
    return strippedMarkersOnly === content ? content : strippedMarkersOnly;
  }

  let end = normalizedLines.length;
  for (let i = start + 1; i < normalizedLines.length; i++) {
    if (normalizedLines[i].startsWith("## ") || normalizedLines[i].startsWith("# ")) {
      end = i;
      break;
    }
  }

  const remaining = [...normalizedLines.slice(0, start), ...normalizedLines.slice(end)].join("\n");
  const collapsed = remaining.replace(/\n{3,}/g, "\n\n").trim();
  return collapsed ? collapsed + "\n" : "";
}

/**
 * Cut everything from `marker` to EOF. Returns the content unchanged when the
 * marker is absent, and "" when nothing but whitespace precedes it (callers
 * typically delete the file then).
 */
export function cutFromMarker(content: string, marker: string): string {
  const idx = content.indexOf(marker);
  if (idx === -1) return content;

  const before = content.slice(0, idx).replace(/\s+$/, "");
  return before.length > 0 ? before + "\n" : "";
}

/**
 * Strip a heading-delimited section from a file in place. Absent files are a
 * no-op; a file left without content is deleted.
 */
export async function stripSectionFromFile(
  filePath: string,
  options: RemoveHeadingSectionOptions,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  const stripped = removeHeadingSection(content, options);
  if (stripped === content) return;
  if (!stripped.trim()) {
    await fs.unlink(filePath);
  } else {
    await fs.writeFile(filePath, stripped, "utf8");
  }
}
