import fs from "node:fs/promises";
import path from "node:path";

import { pruneEmptyAncestors } from "./utils";

export const MATE_ARTIFACT_SKILLS = ["mate-artifact-finish"] as const;
export const MATE_SKILLS = [
  "mate-artifact-finish",
  "mate-create-report",
  "mate-openspec-backfill",
] as const;
const LEGACY_MATE_SKILLS = ["mate-openspec-artifact-finish"] as const;

const MATE_SKILLS_SOURCE = path.join(
  import.meta.dirname,
  "../../templates/capabilities/openspec-cap/mate-skills",
);

const MATE_CREATE_REPORT_SKILL = `---
name: mate-create-report
description: Create a browser-first Mate report from an explicit structured ReportDocument. Use when a skill needs to present supplied metrics, tables, statuses, metadata, or narrative text.
allowed-tools: Bash(mate:*)
license: MIT
compatibility: Requires the mate CLI and the OpenSpec capability enabled.
metadata:
  author: mate
  version: "1.0"
---

Create a report only from structured data supplied by the calling skill. Do not infer missing facts from conversation state.

## Contract

Write a JSON document with this shape:

\`\`\`json
{
  "version": 1,
  "title": "Report title",
  "generatedAt": "2026-01-01T00:00:00Z",
  "period": "Optional reporting period",
  "context": "Optional context",
  "metadata": [{ "label": "Owner", "value": "acme" }],
  "summary": [{ "label": "Requests", "value": 42, "detail": "Optional detail" }],
  "sections": [
    { "id": "notes", "title": "Notes", "type": "text", "content": "Narrative text." },
    {
      "id": "results",
      "title": "Results",
      "type": "table",
      "columns": ["Name", "Value"],
      "rows": [["Example", 1]]
    }
  ]
}
\`\`\`

Supported section types are \`metadata\`, \`metrics\`, \`key-value\`, \`table\`, \`statuses\`, and \`text\`. Use only strings, numbers, booleans, and null values. Section IDs must be unique. Validate required fields before invoking the CLI.

## Invocation

1. Serialize the complete document to a temporary file or pipe it to stdin.
2. Run \`mate report --input <file-or->\`.
3. Add \`--json\` when the caller needs normalized JSON instead of browser delivery.

The default path writes self-contained HTML to a unique OS temporary directory and opens it in the default browser. The report includes a visible "Print / Save as PDF" control that calls the browser's native print dialog. If HTML delivery fails, the CLI warns on stderr and emits the complete report document as JSON on stdout.

The built-in \`mate report\` path collects Mate usage data and adapts it to the same contract and renderer.
`;

export async function deployMateSkillDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await deployMateSkillDir(srcPath, destPath);
      continue;
    }
    await fs.copyFile(srcPath, destPath);
  }
}

const DEFAULT_MATE_SKILLS_BUCKET = "agents";

/**
 * A skill's source lives under a provider bucket so its folder name always
 * matches its `name:` frontmatter: `<tool>/<skill>/` when that tool needs its
 * own behavior (e.g. Claude Code always confirms before `mate artifact
 * finish` pushes, since a push is a shared-state action), falling back to
 * `agents/<skill>/` — the shared default every other tool (e.g. opencode,
 * which pushes automatically) uses.
 */
async function resolveMateSkillSource(skill: string, tool: string): Promise<string> {
  const providerDir = path.join(MATE_SKILLS_SOURCE, tool, skill);
  try {
    await fs.access(providerDir);
    return providerDir;
  } catch {
    return path.join(MATE_SKILLS_SOURCE, DEFAULT_MATE_SKILLS_BUCKET, skill);
  }
}

export async function applyMateSkills(skillsDir: string, tool: string): Promise<void> {
  for (const skill of LEGACY_MATE_SKILLS) {
    await fs.rm(path.join(skillsDir, skill), { recursive: true, force: true });
  }
  for (const skill of MATE_SKILLS) {
    const destination = path.join(skillsDir, skill);
    if (skill === "mate-create-report") {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, "SKILL.md"), MATE_CREATE_REPORT_SKILL, "utf8");
    } else {
      await deployMateSkillDir(await resolveMateSkillSource(skill, tool), destination);
    }
  }
}

export async function teardownMateSkills(skillsDir: string, companionPath: string): Promise<void> {
  for (const skill of [...MATE_SKILLS, ...LEGACY_MATE_SKILLS]) {
    try {
      await fs.rm(path.join(skillsDir, skill), { recursive: true, force: true });
    } catch {
      /* not present */
    }
  }
  await pruneEmptyAncestors(skillsDir, companionPath);
}
