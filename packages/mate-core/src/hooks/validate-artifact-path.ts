// Block artifact writes outside the companion framework path.
//
// Artifact-like files may be written in the working repository only when the
// target path is already ignored by git. That keeps local-only scratch files
// possible without weakening the default repo split.
//
// Editing a file that already exists is always allowed: the guard exists to
// stop new agent artifacts from landing in the working repo, not to freeze
// files that are already part of it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { companionForkRefusal } from "../runtime/companion-sync";
import { readCompanionRuntimeContext } from "../runtime/env";
import { companionLinkPath } from "../runtime/repo-local";

export type HookEnv = Record<string, string | undefined>;

export interface HookOutcome {
  exitCode: number;
  stderr: string;
}

const KNOWN_ARTIFACT_BASENAMES = new Set([
  "CLAUDE.md",
  "CONTEXT.md",
  "design.md",
  "explore-brief.md",
  "proposal.md",
  "spec.md",
  "tasks.md",
]);

const ARTIFACT_PATH_MARKERS = [
  "/changes/",
  "/openspec/",
  "/specs/",
  "/docs/adr/",
  "/docs/adrs/",
  "/docs/decisions/",
  "/docs/prd/",
];

const MD_REDIRECT_PATTERN = />{1,2}\s*([^\s;|&<>]+\.md)\b/g;
const MD_TEE_PATTERN = /\btee\s+(?:-a\s+)?([^\s;|&<>]+\.md)\b/g;

export function artifactLikePath(filePath: string): boolean {
  if (!filePath) return false;

  const basename = path.basename(filePath);
  const normalized = "/" + filePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (KNOWN_ARTIFACT_BASENAMES.has(basename)) return true;

  if (ARTIFACT_PATH_MARKERS.some((marker) => normalized.includes(marker))) return true;

  if (basename.endsWith(".md") && basename !== "README.md") return true;

  return false;
}

/**
 * Resolved once per evaluation: the companion may come from the launch
 * environment or from the Working Repository's Projection Root, and every
 * path check below is relative to whichever resolved.
 */
interface GuardContext {
  env: HookEnv;
  /** As resolved, for the operator: the message names the path they configured. */
  companion: string;
  /** Followed through every link, so filesystem identity decides the verdict. */
  companionReal: string;
  companionLink: string;
  repoRoot: string;
}

/**
 * The target's real path, resolved as far as it exists — a path being written
 * does not yet, so the deepest existing ancestor is resolved and the rest
 * appended.
 */
function realPath(target: string): string {
  const absolute = path.resolve(target);
  const trailing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function guardContext(env: HookEnv, cwd: string): GuardContext | null {
  const resolved = readCompanionRuntimeContext(env, cwd);
  if (!resolved.companionPath) return null;
  const repoRoot = resolved.repositoryPath || cwd;
  return {
    env,
    companion: path.normalize(resolved.companionPath),
    companionReal: realPath(resolved.companionPath),
    companionLink: companionLinkPath(repoRoot),
    repoRoot,
  };
}

// Claude Code's own config/state directory (plan files, settings, todos).
// Writes there are agent-runtime state, never Mate artifacts.
function claudeConfigRoot(env: HookEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) return path.normalize(configured);
  return path.normalize(path.join(env.HOME || os.homedir(), ".claude"));
}

function normalizePath(filePath: string, ctx: GuardContext): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.normalize(path.join(ctx.repoRoot, filePath));
}

function isUnder(target: string, root: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Under the Projection Root's companion link, or under the companion it lands
 * in — the second answers for a link the operator made, and for the first once
 * its target exists.
 */
function isCompanionPath(target: string, ctx: GuardContext): boolean {
  return isUnder(target, ctx.companionLink) || isUnder(realPath(target), ctx.companionReal);
}

function isGitignored(target: string, ctx: GuardContext): boolean {
  const root = ctx.repoRoot;
  if (!isUnder(target, root)) return false;

  const relPath = path.relative(root, target);
  const result = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", relPath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

// A file already tracked in the working repo is product code being edited,
// not a new agent artifact (e.g. packaged SKILL.md/spec.md template sources).
function isGitTracked(target: string, ctx: GuardContext): boolean {
  const root = ctx.repoRoot;
  if (!isUnder(target, root)) return false;

  const relPath = path.relative(root, target);
  const result = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", relPath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function isProductDocumentationPath(target: string, ctx: GuardContext): boolean {
  const root = ctx.repoRoot;
  if (!isUnder(target, root)) return false;

  const relPath = path.relative(root, target);
  const parts = relPath.split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === ".storybook" || part === "storybook") return true;

    if (part !== "docs") continue;

    const docsRoot = path.join(root, ...parts.slice(0, index + 1));
    if (fs.existsSync(path.join(docsRoot, "package.json"))) return true;
  }

  return false;
}

function blockWrite(target: string, companion: string): HookOutcome {
  const lines = [
    "Mate guardrail: artifact writes must go to the companion framework path.",
    ` target: ${target}`,
    ` companion: ${companion}`,
    "Use an absolute path under MATE_ARTIFACT_PATH instead.",
  ];
  if (path.basename(target) === "CLAUDE.md") {
    lines.push(`Note: CLAUDE.md already lives in the companion repo at ${companion}/CLAUDE.md.`);
  }
  return { exitCode: 2, stderr: lines.join("\n") + "\n" };
}

function checkFilePath(
  filePath: string,
  ctx: GuardContext,
  allowExisting = false,
): HookOutcome | null {
  if (!filePath) return null;

  const normalized = normalizePath(filePath, ctx);
  if (isCompanionPath(normalized, ctx)) return null;

  if (isUnder(normalized, claudeConfigRoot(ctx.env))) return null;

  if (allowExisting && fs.existsSync(normalized) && fs.statSync(normalized).isFile()) return null;

  if (isProductDocumentationPath(normalized, ctx)) return null;

  if (!artifactLikePath(filePath)) return null;

  if (
    isUnder(normalized, ctx.repoRoot) &&
    (isGitignored(normalized, ctx) || isGitTracked(normalized, ctx))
  ) {
    return null;
  }

  return blockWrite(filePath, ctx.companion);
}

/**
 * The fork refusal, unlike the path refusal, is not a function of the tool
 * input alone: it depends on companion Git state, which a Managed Launch may
 * have settled on purpose (`--no-git`, a non-automatic Git policy). So it is
 * gated on the absence of a launch environment, and the path refusal keeps its
 * input-only verdict and its double-load tolerance untouched.
 */
function checkForkedCompanion(filePath: string, ctx: GuardContext): HookOutcome | null {
  if (!filePath || !artifactLikePath(filePath)) return null;
  if (!isCompanionPath(normalizePath(filePath, ctx), ctx)) return null;

  const refusal = companionForkRefusal(ctx.env, ctx.companion);
  return refusal ? { exitCode: 2, stderr: `${refusal}\n` } : null;
}

export function commandMatches(command: string): string[] {
  const targets: string[] = [];
  for (const pattern of [MD_REDIRECT_PATTERN, MD_TEE_PATTERN]) {
    const matcher = new RegExp(pattern.source, pattern.flags);
    for (const match of command.matchAll(matcher)) {
      const target = match[1].trim().replace(/^["']+|["']+$/g, "");
      if (target) targets.push(target);
    }
  }
  return targets;
}

/**
 * Fails open only when no Mate context resolves from either source; in a
 * wrapped Working Repository the guard runs without a launch.
 */
export function evaluate(payload: unknown, env: HookEnv, cwd: string = process.cwd()): HookOutcome {
  const allow: HookOutcome = { exitCode: 0, stderr: "" };

  const ctx = guardContext(env, cwd);
  if (!ctx) return allow;

  const input = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const filePath = String(toolInput.file_path ?? "");
    /** The path refusal wins when both apply: its message is not replaced. */
    const outcome = checkFilePath(filePath, ctx, toolName === "Edit" || toolName === "MultiEdit");
    return outcome ?? checkForkedCompanion(filePath, ctx) ?? allow;
  }

  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");
    const targets = commandMatches(command);
    for (const target of targets) {
      const outcome = checkFilePath(target, ctx);
      if (outcome) return outcome;
    }
    for (const target of targets) {
      const outcome = checkForkedCompanion(target, ctx);
      if (outcome) return outcome;
    }
    return allow;
  }

  return allow;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Plugin-shim entry: read the hook payload from stdin, evaluate, report.
export async function run(): Promise<number> {
  let payload: unknown = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    payload = {};
  }
  const outcome = evaluate(payload, process.env);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  return outcome.exitCode;
}
