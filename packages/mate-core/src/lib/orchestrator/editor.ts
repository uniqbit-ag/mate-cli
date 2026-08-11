import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

type SpawnLike = typeof spawn;

const CURSOR_FALLBACK_PATHS = [
  "/usr/local/bin/cursor",
  `${process.env.HOME}/.cursor/bin/cursor`,
  "/opt/homebrew/bin/cursor",
];

export function isCursorSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  const bundleId = env.__CFBundleIdentifier ?? "";
  return (
    termProgram === "cursor" || bundleId.startsWith("com.todesktop") || Boolean(env.CURSOR_TRACE_ID)
  );
}

export function isVsCodeSession(env: NodeJS.ProcessEnv = process.env): boolean {
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

export function writeMissingEditorCliGuidance(
  cli: string,
  write: (chunk: string) => boolean = process.stderr.write.bind(process.stderr),
): void {
  write(`mate: warning: ${cli} CLI not found on PATH.\n`);
  write(`mate: run "Install '${cli}' command in PATH" from the Command Palette to enable this.\n`);
}

export function editorWorkspacePath(repoPath: string): string {
  return path.join(path.resolve(repoPath), ".mate", "workspace.code-workspace");
}

export interface WorkspaceDocument {
  workspacePath: string;
  folders: [string, string];
}

/**
 * Writes the generated `.mate/workspace.code-workspace` file (working
 * repository first, companion second) and returns its path and folder
 * order. Shared by editor-launching `injectEditorFolder` and the
 * non-launching `workspace materialize` command — both must produce the
 * same document for the same pairing.
 */
export async function writeWorkspaceDocument(
  companionPath: string,
  repoPath: string,
): Promise<WorkspaceDocument> {
  const folders: [string, string] = [path.resolve(repoPath), path.resolve(companionPath)];
  const workspacePath = editorWorkspacePath(repoPath);
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  await fs.writeFile(
    workspacePath,
    `${JSON.stringify(
      {
        folders: folders.map((candidate) => ({ path: candidate })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { workspacePath, folders };
}

export async function injectEditorFolder(
  companionPath: string,
  repoPath: string,
  cli = "code",
  spawnProcess: SpawnLike = spawn,
): Promise<boolean> {
  const resolved = resolveEditorCli(cli);
  if (!resolved) {
    process.stderr.write(
      `mate: warning: ${cli} CLI not found on PATH; skipping workspace injection.\n`,
    );
    process.stderr.write(
      `mate: run "Install '${cli}' command in PATH" from the Command Palette to enable this.\n`,
    );
    return false;
  }

  const { binary } = resolved;

  const { folders: workspaceFolders } = await writeWorkspaceDocument(companionPath, repoPath);

  const child = spawnProcess(binary, ["--add", ...workspaceFolders], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", (error) => {
    process.stderr.write(`mate: warning: failed to open companion in ${cli}: ${error.message}\n`);
  });
  child.unref();

  return true;
}
