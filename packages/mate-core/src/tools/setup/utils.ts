// oxlint-disable no-await-in-loop
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Merges src into dest: existing files are kept, but src wins on name clashes.
export async function mergeDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "__pycache__") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await mergeDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// Walks up from `dir` toward `stopAt`, removing each directory that is empty.
// Stops as soon as a non-empty directory (or an error) is encountered.
export async function pruneEmptyAncestors(dir: string, stopAt: string): Promise<void> {
  let current = path.resolve(dir);
  const stop = path.resolve(stopAt);
  while (current !== stop && current.startsWith(stop)) {
    try {
      await fs.rmdir(current); // throws if non-empty or missing
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}

export { isCommandOnPath } from "../../lib/fs-utils";

export function resolveCommandOnPath(command: string, pathValue: string): string | undefined {
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

function waitForClose(child: ChildProcess, formatError: (code: number) => string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(formatError(code ?? 1)));
    });
  });
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<void> {
  const child = spawn(command, args, { cwd: options.cwd, stdio: "inherit" });
  await waitForClose(child, (code) => `${command} ${args.join(" ")} exited with code ${code}`);
}

export async function runCommandSilently(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<void> {
  const child = spawn(command, args, { cwd: options.cwd, stdio: "pipe" });
  await waitForClose(child, (code) => `${command} ${args.join(" ")} exited with code ${code}`);
}

export async function runShellCommand(
  command: string,
  options: { cwd?: string } = {},
): Promise<void> {
  const child = spawn(command, { cwd: options.cwd, stdio: "inherit", shell: true });
  await waitForClose(child, (code) => `Command failed: ${command} (exit ${code})`);
}

export async function runShellCommandSilently(
  command: string,
  options: { cwd?: string } = {},
): Promise<void> {
  const child = spawn(command, { cwd: options.cwd, stdio: "pipe", shell: true });
  await waitForClose(child, (code) => `Command failed: ${command} (exit ${code})`);
}
