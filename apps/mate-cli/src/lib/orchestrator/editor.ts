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

export async function injectEditorFolder(
  companionPath: string | string[],
  repoPath: string,
  cli = "code",
  spawnProcess: SpawnLike = spawn,
): Promise<boolean> {
  const binary = resolveEditorBinary(cli);
  if (!binary) {
    process.stderr.write(
      `mate: warning: ${cli} CLI not found on PATH; skipping workspace injection.\n`,
    );
    process.stderr.write(
      `mate: run "Install '${cli}' command in PATH" from the Command Palette to enable this.\n`,
    );
    return false;
  }

  const companionPaths = (Array.isArray(companionPath) ? companionPath : [companionPath]).map(
    (candidate) => path.resolve(candidate),
  );

  const workspacePath = editorWorkspacePath(repoPath);
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  await fs.writeFile(
    workspacePath,
    `${JSON.stringify(
      {
        folders: [
          { path: path.resolve(repoPath) },
          ...companionPaths.map((candidate) => ({ path: candidate })),
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const child = spawnProcess(binary, ["--add", path.resolve(repoPath), ...companionPaths], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", (error) => {
    process.stderr.write(`mate: warning: failed to open companion in ${cli}: ${error.message}\n`);
  });
  child.unref();

  return true;
}

export function openEditorWorkspace(paths: string[], cli: string): boolean {
  const binary = resolveEditorBinary(cli);
  if (!binary) {
    writeMissingEditorCliGuidance(cli);
    return false;
  }

  execFileSync(binary, paths, { stdio: "ignore" });
  return true;
}
