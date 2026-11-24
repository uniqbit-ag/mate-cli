import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { gitEnvironment } from "./companion-git";

/**
 * Whether Git tracks a repo-relative path in a Working Repository. Any
 * `ls-files` failure, a non-Git checkout included, reads as untracked.
 */

const execFileAsync = promisify(execFile);

/** On a case-insensitive file system a tracked case variant opens as the same file. */
function listed(stdout: string, repoPath: string, relativePath: string): boolean {
  const entries = stdout.split("\0").filter(Boolean);
  if (entries.includes(relativePath)) return true;
  const target = lstatOrNull(path.join(repoPath, relativePath));
  return entries.some((entry) => {
    const stat = lstatOrNull(path.join(repoPath, entry));
    return target !== null && stat?.ino === target.ino && stat.dev === target.dev;
  });
}

function lstatOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate);
  } catch {
    return null;
  }
}

function lsFiles(repoPath: string, ...relativePaths: string[]) {
  return {
    args: ["ls-files", "-z", "--", ...relativePaths.map((entry) => `:(icase,literal)${entry}`)],
    options: { cwd: path.resolve(repoPath), encoding: "utf8" as const, env: gitEnvironment() },
  };
}

export async function gitTracks(repoPath: string, relativePath: string): Promise<boolean> {
  try {
    const { args, options } = lsFiles(repoPath, relativePath);
    const { stdout } = await execFileAsync("git", args, options);
    return listed(stdout, options.cwd, relativePath);
  } catch {
    return false;
  }
}

/** The tracked files at or below the repo-relative `paths`; empty when Git cannot answer. */
export async function gitTrackedUnder(repoPath: string, paths: string[]): Promise<string[]> {
  try {
    const { args, options } = lsFiles(repoPath, ...paths);
    const { stdout } = await execFileAsync("git", args, options);
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** For session-start readers that cannot await. */
export function gitTracksSync(repoPath: string, relativePath: string): boolean {
  try {
    const { args, options } = lsFiles(repoPath, relativePath);
    const stdout = execFileSync("git", args, { ...options, stdio: ["ignore", "pipe", "ignore"] });
    return listed(stdout, options.cwd, relativePath);
  } catch {
    return false;
  }
}
