import { spawn } from "node:child_process";
import { accessSync } from "node:fs";

import { version } from "../../../../package.json";
import { resolveFrameworkContext } from "../../../lib/orchestrator/framework-context";
import { findRepoLocalLinkedRepository } from "../../../lib/orchestrator/repo-local-registry";
import { ensureUnambiguousCompanion } from "../launch/shared";

export function renderBanner(repoPath: string, companionPath: string): string {
  const lines = [`mate v${version}`, "", `repo: ${repoPath}`, `mate: ${companionPath}`];
  const contentWidth = Math.max(...lines.map((l) => l.length));
  const pad = (text: string) => `│ ${text.padEnd(contentWidth)} │`;
  const border = `─`.repeat(contentWidth + 2);

  return [`╭${border}╮`, ...lines.map(pad), `╰${border}╯`].join("\n");
}

export function resolveShell(): string {
  const shell = process.env.SHELL;
  if (shell) {
    try {
      accessSync(shell);
      return shell;
    } catch {
      // SHELL points to non-existent binary, fall through
    }
  }
  return "/bin/sh";
}

export async function resolveCompanionPath(
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  const envCompanionPath = process.env.MATE_ARTIFACT_PATH;
  if (envCompanionPath) return envCompanionPath;

  try {
    const repositoryPath = process.env.MATE_REPO_PATH ?? cwd;
    return (await resolveFrameworkContext(repositoryPath)).companionPath;
  } catch {
    return undefined;
  }
}

export async function resolveRepoPath(cwd: string = process.cwd()): Promise<string> {
  const repository = await findRepoLocalLinkedRepository(cwd);
  return repository?.path ?? cwd;
}

export async function runCompanionTuiCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "mate: companion tui requires an interactive terminal. Re-run in a TTY.\n",
    );
    process.exitCode = 1;
    return;
  }

  const unambiguous = await ensureUnambiguousCompanion(process.cwd(), { reselect: true });
  if (!unambiguous) {
    process.exitCode = 1;
    return;
  }

  const companionPath = await resolveCompanionPath();

  if (!companionPath) {
    process.stderr.write("mate: could not resolve companion path.\n");
    process.exitCode = 1;
    return;
  }

  const repoPath = await resolveRepoPath(process.cwd());
  const repository = await findRepoLocalLinkedRepository(repoPath);

  process.env.MATE_ARTIFACT_PATH = companionPath;
  process.env.MATE_VERSION = version;
  if (repository) {
    process.env.MATE_REPO_PATH = repository.path;
    process.env.MATE_REPO_ID = repository.id;
    process.env.MATE_REPO_PROFILE = repository.profile;
  }

  console.log(renderBanner(repoPath, companionPath));
  console.log("");
  console.log("Type `exit` to return to your previous shell.");
  console.log("");

  const shell = resolveShell();
  const child = spawn(shell, [], {
    cwd: companionPath,
    stdio: "inherit",
    env: { ...process.env },
  });

  child.on("error", (error) => {
    process.stderr.write(`mate: failed to spawn shell: ${error.message}\n`);
    process.exitCode = 1;
  });

  child.on("close", (code) => {
    process.exitCode = code ?? 0;
  });
}
