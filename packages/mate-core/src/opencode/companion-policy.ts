import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { persistedCompanionGitStalenessLines } from "../runtime/companion-sync";
import { resolveCompanionRuntime, type CompanionRuntimeContext } from "../runtime/env";
import { projectionFreshness, projectionStalenessLines } from "../runtime/freshness";

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
  const normalized = normalizeTargetPath(context, filePath);
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

export function normalizeTargetPath(context: CompanionContext, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath);
  }

  return path.normalize(path.join(context.repositoryPath, filePath));
}

export function isGitignored(context: CompanionContext, filePath: string): boolean {
  if (!context.repositoryPath) {
    return false;
  }

  const normalized = normalizeTargetPath(context, filePath);
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

  if (normalizeTargetPath(context, filePath).startsWith(path.normalize(context.companionPath))) {
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

export function buildArtifactError(context: CompanionContext, filePath: string): string {
  const rel = path.relative(context.repositoryPath, filePath);
  const suggested = path.join(context.companionPath, rel);

  return [
    `${context.frameworkName} guardrail: artifact writes must go to the companion framework path.`,
    `  target:   ${filePath}`,
    `  suggested: ${suggested}`,
    `Rewrite to ${suggested} and retry.`,
  ].join("\n");
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

  return {
    ...context,
    agentsMd,
    stalenessLines: projection
      ? [
          ...projectionStalenessLines(projection, projectionFreshness(projection)),
          ...persistedCompanionGitStalenessLines(context.companionPath),
        ]
      : [],
  };
}
