import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { artifactRefusal, resolveArtifactTarget } from "../runtime/artifact-refusal";
import { persistedCompanionGitStalenessLines } from "../runtime/companion-sync";
import { resolveCompanionRuntime, type CompanionRuntimeContext } from "../runtime/env";
import { projectionFreshness, projectionStalenessLines } from "../runtime/freshness";
import { readSessionNotes } from "./session-notes";

export type CompanionContext = CompanionRuntimeContext & {
  agentsMd: string;
  /**
   * Operator-facing session state: a stale projection, and an unfinished
   * companion Git synchronization. Never reaches a model payload — the TUI is
   * its only reader.
   */
  stalenessLines: string[];
};

const ARTIFACT_BASENAMES = new Set([
  "CLAUDE.md",
  "CONTEXT.md",
  "design.md",
  "explore-brief.md",
  "proposal.md",
  "spec.md",
  "tasks.md",
]);
const ARTIFACT_SEGMENTS = [
  "/changes/",
  "/openspec/",
  "/specs/",
  "/docs/adr/",
  "/docs/adrs/",
  "/docs/decisions/",
  "/docs/prd/",
];
function normalizedPolicyPath(filePath: string): string {
  return `/${filePath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

export function isArtifactPath(filePath: string): boolean {
  const basename = path.basename(filePath);
  const ext = path.extname(basename).toLowerCase();
  const normalized = normalizedPolicyPath(filePath);

  if (ARTIFACT_BASENAMES.has(basename)) {
    return true;
  }

  if (ARTIFACT_SEGMENTS.some((segment) => normalized.includes(segment))) {
    return true;
  }

  if (ext === ".md" && basename !== "README.md") {
    return true;
  }

  return false;
}

export function isProductDocumentationPath(context: CompanionContext, filePath: string): boolean {
  const normalized = resolveArtifactTarget(filePath, context.repositoryPath);
  const relativePath = path.relative(context.repositoryPath, normalized);
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }

  const parts = relativePath.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === ".storybook" || part === "storybook") {
      return true;
    }

    if (part !== "docs") {
      continue;
    }

    const docsRoot = path.join(context.repositoryPath, ...parts.slice(0, index + 1));
    if (fs.existsSync(path.join(docsRoot, "package.json"))) {
      return true;
    }
  }

  return false;
}

export function isCompanionTarget(context: CompanionContext, filePath: string): boolean {
  return resolveArtifactTarget(filePath, context.repositoryPath).startsWith(
    path.normalize(context.companionPath),
  );
}

export function isGitignored(context: CompanionContext, filePath: string): boolean {
  if (!context.repositoryPath) {
    return false;
  }

  const normalized = resolveArtifactTarget(filePath, context.repositoryPath);
  if (!normalized.startsWith(path.normalize(context.repositoryPath))) {
    return false;
  }

  const relativePath = path.relative(context.repositoryPath, normalized);
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }

  const result = spawnSync(
    "git",
    ["-C", context.repositoryPath, "check-ignore", "--no-index", "-q", "--", relativePath],
    {
      encoding: "utf8",
      stdio: "ignore",
    },
  );

  return result.status === 0;
}

export function shouldBlockArtifactWrite(context: CompanionContext, filePath: string): boolean {
  if (!filePath) {
    return false;
  }

  if (isCompanionTarget(context, filePath)) {
    return false;
  }

  if (isProductDocumentationPath(context, filePath)) {
    return false;
  }

  if (!isArtifactPath(filePath)) {
    return false;
  }

  return !isGitignored(context, filePath);
}

const PATCH_FILE_MARKER = /\*\*\* (?:Add|Update|Move to|Delete) File:\s*(.+)$/gm;

export function extractPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  let match;
  while ((match = PATCH_FILE_MARKER.exec(patchText)) !== null) {
    const raw = match[1].trim();
    if (raw) {
      paths.push(raw);
    }
  }
  return paths;
}

/**
 * What a patch would add to each file it touches: the `+` lines of every
 * section, keyed by the section's target (a move's destination when present).
 */
export function extractPatchAdditions(patchText: string): { path: string; content: string }[] {
  const additions: { path: string; content: string[] }[] = [];
  let current: { path: string; content: string[] } | undefined;
  for (const line of patchText.split("\n")) {
    const marker = /^\*\*\* (Add|Update|Delete|Move to) File:\s*(.+)$/.exec(line);
    if (marker) {
      if (marker[1] === "Move to" && current) {
        current.path = marker[2].trim();
      } else {
        current = { path: marker[2].trim(), content: [] };
        additions.push(current);
      }
      continue;
    }
    if (current && line.startsWith("+")) current.content.push(line.slice(1));
  }
  return additions.map((entry) => ({ path: entry.path, content: entry.content.join("\n") }));
}

export function buildArtifactError(context: CompanionContext, filePath: string): string {
  return artifactRefusal({
    target: filePath,
    resolved: resolveArtifactTarget(filePath, context.repositoryPath),
    companion: context.companionPath,
    repoRoot: context.repositoryPath,
  });
}

/**
 * Resolves its own companion — launch environment first, Projection Root
 * second — rather than taking one from the caller. `AGENTS.md` follows the
 * resolved companion so the two cannot name different repositories.
 */
export function readContext(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): CompanionContext {
  const { context, projection } = resolveCompanionRuntime(env, cwd);

  let agentsMd = "";
  if (context.companionPath) {
    const agentsMdPath = path.join(context.companionPath, "AGENTS.md");
    try {
      if (fs.existsSync(agentsMdPath)) {
        agentsMd = fs.readFileSync(agentsMdPath, "utf8");
      }
    } catch {
      // Ignore read errors; AGENTS.md is optional
    }
  }

  return { ...context, agentsMd, stalenessLines: stalenessLinesFor(context, projection) };
}

function stalenessLinesFor(
  context: CompanionRuntimeContext,
  projection: ReturnType<typeof resolveCompanionRuntime>["projection"],
): string[] {
  if (!projection) return [];
  /** A sync note repeats the persisted Git line it came from. */
  return [
    ...new Set([
      ...projectionStalenessLines(projection, projectionFreshness(projection)),
      ...persistedCompanionGitStalenessLines(context.companionPath, undefined, "opencode"),
      ...(context.repositoryPath ? readSessionNotes(context.repositoryPath) : []),
    ]),
  ];
}

/** The session state alone, cheap enough for the TUI to poll: no `AGENTS.md` read, no Git. */
export function readStalenessLines(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string[] {
  const { context, projection } = resolveCompanionRuntime(env, cwd);
  return stalenessLinesFor(context, projection);
}
