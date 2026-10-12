import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../framework";
import {
  runtimeDirectoryPath,
  runtimeMateBin,
  runtimeOpenCodePluginRoot,
  runtimeWrapperBinPath,
} from "../runtime/runtime-directory";
import { writeAtomic } from "../runtime/write-atomic";
import { getOpenCodePluginRoot, getWrapperBinPath } from "./package-paths";

export interface RuntimeDirectoryTargets {
  pluginRoot: string;
  /** The resolved `wrappers/bin`; its parent is what the `wrappers` link names. */
  wrapperBinPath: string;
  /** The interpreter running this CLI, written into the launcher. */
  execPath: string;
  cliEntry: string;
}

export interface RuntimeDirectoryRefresh {
  /** Entries rewritten by this run, relative to the runtime directory. */
  changed: string[];
}

/**
 * `process.execPath` is the resolved, often versioned, binary (Homebrew's
 * `Cellar/bun/<version>/bin/bun`), which an upgrade deletes. A `PATH` entry of
 * the same name that is a link to it survives the upgrade; without one the
 * resolved path is all there is.
 */
export function stableInterpreterPath(
  execPath: string,
  pathValue: string | undefined = process.env.PATH,
): string {
  let real: string;
  try {
    real = fsSync.realpathSync(execPath);
  } catch {
    return execPath;
  }
  const name = path.basename(execPath);
  for (const dir of (pathValue ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (candidate === real) continue;
    try {
      if (fsSync.realpathSync(candidate) === real) return candidate;
    } catch {
      /* not on this PATH entry */
    }
  }
  return execPath;
}

function currentRuntimeDirectoryTargets(): RuntimeDirectoryTargets {
  return {
    pluginRoot: getOpenCodePluginRoot(),
    wrapperBinPath: getWrapperBinPath(),
    execPath: stableInterpreterPath(process.execPath),
    cliEntry: path.resolve(process.argv[1] ?? ""),
  };
}

async function readLinkTarget(linkPath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) return "";
    return path.resolve(path.dirname(linkPath), await fs.readlink(linkPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Junctions on Windows need no admin rights or Developer Mode. On POSIX a
 * sibling link renamed over the old one keeps concurrent runs from ever seeing
 * the entry missing.
 */
async function pointLink(linkPath: string, target: string): Promise<boolean> {
  const current = await readLinkTarget(linkPath);
  if (current === path.resolve(target)) return false;
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  if (process.platform === "win32") {
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(target, linkPath, "junction");
    return true;
  }
  /** A rename cannot replace a real directory or file. */
  if (current === "") await fs.rm(linkPath, { recursive: true, force: true });
  const tempPath = `${linkPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.symlink(target, tempPath, "dir");
    await fs.rename(tempPath, linkPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function launcherContent(targets: RuntimeDirectoryTargets, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `@echo off\r\n"${targets.execPath}" "${targets.cliEntry}" %*\r\n`;
  }
  return `#!/bin/sh\nexec ${shellQuote(targets.execPath)} ${shellQuote(targets.cliEntry)} "$@"\n`;
}

async function writeLauncher(
  launcherPath: string,
  targets: RuntimeDirectoryTargets,
): Promise<boolean> {
  const next = launcherContent(targets, process.platform);
  const existing = await fs.readFile(launcherPath, "utf8").catch(() => null);
  if (existing === next) return false;
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await writeAtomic(launcherPath, next, 0o755);
  return true;
}

/** Re-points or rewrites only the entries whose target differs from `targets`. */
export async function refreshRuntimeDirectory(
  targets: RuntimeDirectoryTargets = currentRuntimeDirectoryTargets(),
  homeDir?: string,
): Promise<RuntimeDirectoryRefresh> {
  const root = runtimeDirectoryPath(homeDir);
  const launcherPath = runtimeMateBin(homeDir);
  const changed: string[] = [];
  if (await pointLink(runtimeOpenCodePluginRoot(homeDir), targets.pluginRoot)) {
    changed.push("opencode-plugin");
  }
  const wrappersLink = path.dirname(runtimeWrapperBinPath(homeDir));
  if (await pointLink(wrappersLink, path.dirname(targets.wrapperBinPath))) {
    changed.push("wrappers");
  }
  if (await writeLauncher(launcherPath, targets)) {
    changed.push(path.relative(root, launcherPath).split(path.sep).join("/"));
  }
  return { changed };
}

/** Commands whose output names runtime-directory paths cannot run without it. */
const RUNTIME_DIRECTORY_COMMANDS = new Set(["wrap", "opencode", "session"]);

function runtimeDirectoryRequired(command: string | undefined): boolean {
  return command !== undefined && RUNTIME_DIRECTORY_COMMANDS.has(command);
}

/**
 * Startup refresh: a failure warns, except for the commands that write or
 * consume runtime-directory paths, where it is returned as fatal.
 */
export async function ensureRuntimeDirectory(
  command: string | undefined,
  refresh: () => Promise<RuntimeDirectoryRefresh> = () => refreshRuntimeDirectory(),
): Promise<boolean> {
  try {
    await refresh();
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `failed to update ${runtimeDirectoryPath()}: ${detail}`;
    if (runtimeDirectoryRequired(command)) {
      console.error(`${FRAMEWORK_NAME}: ${message}`);
      return false;
    }
    console.error(`${FRAMEWORK_NAME}: warning: ${message}`);
    return true;
  }
}
