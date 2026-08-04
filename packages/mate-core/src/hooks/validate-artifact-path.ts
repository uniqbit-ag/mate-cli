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

function repoRoot(env: HookEnv): string {
  return env.MATE_REPO_PATH || process.cwd();
}

function companionRoot(env: HookEnv): string | null {
  const companion = env.MATE_ARTIFACT_PATH;
  return companion ? path.normalize(companion) : null;
}

// Claude Code's own config/state directory (plan files, settings, todos).
// Writes there are agent-runtime state, never Mate artifacts.
function claudeConfigRoot(env: HookEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) return path.normalize(configured);
  return path.normalize(path.join(env.HOME || os.homedir(), ".claude"));
}

function normalizePath(filePath: string, env: HookEnv): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.normalize(path.join(repoRoot(env), filePath));
}

function isUnder(target: string, root: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isGitignored(target: string, env: HookEnv): boolean {
  const root = repoRoot(env);
  if (!isUnder(target, root)) return false;

  const relPath = path.relative(root, target);
  const result = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", relPath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

// A file already tracked in the working repo is product code being edited,
// not a new agent artifact (e.g. packaged SKILL.md/spec.md template sources).
function isGitTracked(target: string, env: HookEnv): boolean {
  const root = repoRoot(env);
  if (!isUnder(target, root)) return false;

  const relPath = path.relative(root, target);
  const result = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", relPath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function isProductDocumentationPath(target: string, env: HookEnv): boolean {
  const root = repoRoot(env);
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
  companion: string | null,
  env: HookEnv,
  allowExisting = false,
): HookOutcome | null {
  if (!filePath || !companion) return null;

  const normalized = normalizePath(filePath, env);
  if (normalized.startsWith(companion)) return null;

  if (isUnder(normalized, claudeConfigRoot(env))) return null;

  if (allowExisting && fs.existsSync(normalized) && fs.statSync(normalized).isFile()) return null;

  if (isProductDocumentationPath(normalized, env)) return null;

  if (!artifactLikePath(filePath)) return null;

  if (
    isUnder(normalized, repoRoot(env)) &&
    (isGitignored(normalized, env) || isGitTracked(normalized, env))
  ) {
    return null;
  }

  return blockWrite(filePath, companion);
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

export function evaluate(payload: unknown, env: HookEnv): HookOutcome {
  const allow: HookOutcome = { exitCode: 0, stderr: "" };

  const companion = companionRoot(env);
  if (!companion) return allow;

  const input = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const outcome = checkFilePath(
      String(toolInput.file_path ?? ""),
      companion,
      env,
      toolName === "Edit" || toolName === "MultiEdit",
    );
    return outcome ?? allow;
  }

  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");
    for (const target of commandMatches(command)) {
      const outcome = checkFilePath(target, companion, env);
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
