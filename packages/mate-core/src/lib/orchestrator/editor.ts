import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { workspaceDocumentPath } from "./projection-entries";
import { project } from "./working-repo-projection";

type SpawnLike = typeof spawn;

const CURSOR_FALLBACK_PATHS = [
  "/usr/local/bin/cursor",
  `${process.env.HOME}/.cursor/bin/cursor`,
  "/opt/homebrew/bin/cursor",
];

function isCursorSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  const bundleId = env.__CFBundleIdentifier ?? "";
  return (
    termProgram === "cursor" || bundleId.startsWith("com.todesktop") || Boolean(env.CURSOR_TRACE_ID)
  );
}

function isVsCodeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  const bundleId = env.__CFBundleIdentifier ?? "";
  return (
    termProgram === "vscode" ||
    bundleId.startsWith("com.microsoft.VSCode") ||
    Boolean(env.VSCODE_IPC_HOOK)
  );
}

export function detectInvokingEditorCli(
  env: NodeJS.ProcessEnv = process.env,
): "code" | "cursor" | null {
  if (isCursorSession(env)) return "cursor";
  if (isVsCodeSession(env)) return "code";
  return null;
}

export function getPreferredEditorCli(env: NodeJS.ProcessEnv = process.env): "code" | "cursor" {
  return detectInvokingEditorCli(env) ?? "code";
}

export function resolveEditorBinary(cli: string): string | null {
  try {
    return execFileSync("which", [cli], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    if (cli === "cursor") {
      for (const candidate of CURSOR_FALLBACK_PATHS) {
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
}

function resolveEditorCli(cli: string): { cli: string; binary: string } | null {
  const candidates = cli === "code" ? ["code", "code-insiders"] : [cli];
  for (const candidate of candidates) {
    const binary = resolveEditorBinary(candidate);
    if (binary) return { cli: candidate, binary };
  }
  return null;
}

/** The Projection Root owns the path; this is the editor's name for it. */
export const editorWorkspacePath = workspaceDocumentPath;

/**
 * Merges the working repository and each companion, in the given order, into
 * `.mate/workspace.code-workspace` and returns its path, or the error that
 * left the document unchanged. Backs `openEditorWorkspace`.
 */
async function writeWorkspaceDocument(
  companionPaths: string[],
  repoPath: string,
): Promise<{ workspacePath: string; error?: Error }> {
  const { outcomes } = await project("workspace", {
    repoPath,
    workspaceCompanionPaths: companionPaths,
  });
  const failure = outcomes.find(
    (outcome) => outcome.id === "workspace-document" && outcome.state === "failed",
  );
  return {
    workspacePath: workspaceDocumentPath(repoPath),
    error: failure ? (failure.error ?? new Error("workspace document write failed")) : undefined,
  };
}

/**
 * Updates the workspace document, then opens it in the editor (`<cli> <file>`)
 * so its settings apply. Returns `false` without spawning when the editor CLI
 * is missing or the document could not be updated.
 */
export async function openEditorWorkspace(
  companionPaths: string[],
  repoPath: string,
  cli = "code",
  spawnProcess: SpawnLike = spawn,
): Promise<boolean> {
  const resolved = resolveEditorCli(cli);
  if (!resolved) {
    process.stderr.write(`mate: warning: ${cli} CLI not found on PATH; skipping workspace open.\n`);
    process.stderr.write(
      `mate: run "Install '${cli}' command in PATH" from the Command Palette to enable this.\n`,
    );
    return false;
  }

  const { workspacePath, error } = await writeWorkspaceDocument(companionPaths, repoPath);
  if (error) {
    process.stderr.write(`mate: warning: ${workspacePath}: ${error.message}\n`);
    return false;
  }

  const child = spawnProcess(resolved.binary, [workspacePath], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", (spawnError) => {
    process.stderr.write(
      `mate: warning: failed to open the workspace in ${cli}: ${spawnError.message}\n`,
    );
  });
  child.unref();

  return true;
}
