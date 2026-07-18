import fs from "node:fs/promises";
import path from "node:path";

import { frameworkConfig } from "../../../framework";
import { removeGraphifySection } from "../capabilities/graphify";

const GUIDANCE_START = `<!-- ${frameworkConfig.name.toUpperCase()}:COMPANION:START -->`;
const GUIDANCE_END = `<!-- ${frameworkConfig.name.toUpperCase()}:COMPANION:END -->`;
const LEGACY_GUIDANCE_STARTS = [
  "<!-- COMPANION:GUIDANCE:START -->",
  `<!-- ${frameworkConfig.name.toUpperCase()}:COMPANION:GUIDANCE:START -->`,
  ...frameworkConfig.legacyNames.map((n) => `<!-- ${n.toUpperCase()}:COMPANION:GUIDANCE:START -->`),
];
const LEGACY_GUIDANCE_ENDS = [
  "<!-- COMPANION:GUIDANCE:END -->",
  `<!-- ${frameworkConfig.name.toUpperCase()}:COMPANION:GUIDANCE:END -->`,
  ...frameworkConfig.legacyNames.map((n) => `<!-- ${n.toUpperCase()}:COMPANION:GUIDANCE:END -->`),
];

const GRAPHIFY_START = `<!-- ${frameworkConfig.name.toUpperCase()}:GRAPHIFY:START -->`;
const GRAPHIFY_END = `<!-- ${frameworkConfig.name.toUpperCase()}:GRAPHIFY:END -->`;

// All MATE-managed block markers for stripping
const ALL_MATE_STARTS = [GUIDANCE_START, ...LEGACY_GUIDANCE_STARTS, GRAPHIFY_START];
const ALL_MATE_ENDS = [GUIDANCE_END, ...LEGACY_GUIDANCE_ENDS, GRAPHIFY_END];

export async function stripGuidanceBlock(filePath: string): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  // Strip all MATE-managed blocks iteratively
  let content = existing;
  let changed = true;
  while (changed) {
    changed = false;
    for (const startMarker of ALL_MATE_STARTS) {
      if (!content.includes(startMarker)) continue;
      const startIdx = content.indexOf(startMarker);
      const endMarker = ALL_MATE_ENDS.find((m) => content.indexOf(m, startIdx) > startIdx);
      const endIdx = endMarker
        ? content.indexOf(endMarker, startIdx) + endMarker.length
        : startIdx + startMarker.length;
      const before = content.slice(0, startIdx);
      const after = content.slice(endIdx);
      content = (before + after).replace(/\n{3,}/g, "\n\n").trimEnd();
      changed = true;
      break; // restart loop since content changed
    }
  }

  content = removeGraphifySection(content);

  await fs.writeFile(filePath, content ? content + "\n" : "", "utf8");
}

/**
 * Refreshes a file from a template, preserving any non-MATE content.
 * Strips all MATE-managed blocks (COMPANION, GRAPHIFY) from the existing file,
 * then prepends the fresh template content.
 */
export async function refreshFromTemplate(
  filePath: string,
  templatePath: string,
  options: boolean | { ensureParentDir?: boolean; appendSections?: string[] } = false,
): Promise<void> {
  const normalizedOptions =
    typeof options === "boolean" ? { ensureParentDir: options } : (options ?? {});
  let templateContent = "";
  try {
    templateContent = await fs.readFile(templatePath, "utf8");
  } catch {
    return;
  }

  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    // File doesn't exist yet, just copy template
  }

  // Strip all MATE-managed blocks from existing content
  let remaining = existing;
  for (const startMarker of ALL_MATE_STARTS) {
    if (!remaining.includes(startMarker)) continue;
    const startIdx = remaining.indexOf(startMarker);
    const endMarker = ALL_MATE_ENDS.find((m) => remaining.indexOf(m, startIdx) > startIdx);
    const endIdx = endMarker
      ? remaining.indexOf(endMarker, startIdx) + endMarker.length
      : startIdx + startMarker.length;
    const before = remaining.slice(0, startIdx);
    const after = remaining.slice(endIdx);
    remaining = (before + after).replace(/\n{3,}/g, "\n\n").trimEnd();
  }

  remaining = removeGraphifySection(remaining).trimEnd();

  const sections = [
    templateContent.trimEnd(),
    ...(normalizedOptions.appendSections ?? []).map((section) => section.trim()).filter(Boolean),
  ];
  if (remaining) {
    sections.push(remaining);
  }

  const result = sections.filter(Boolean).join("\n\n") + "\n";

  if (normalizedOptions.ensureParentDir) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }
  await fs.writeFile(filePath, result, "utf8");
}
