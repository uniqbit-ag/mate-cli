import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GitLocation } from "./config";

/**
 * Finding the Companion Repositories the container serves, and checking out
 * the ones the operator named that are not there yet.
 *
 * Nothing here reconfigures a companion. An existing checkout is used exactly
 * as it is: not re-cloned, not reset, not pointed at another remote. Where the
 * configuration disagrees with what is on disk, that is reported, because a
 * container that could quietly replace the companion it was handed would be a
 * worse tool than one that refuses to start.
 */

/** What marks a directory as a Companion Repository. */
export const COMPANION_CONFIG = path.join(".mate", "config", "framework.yaml");

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], cwd?: string) => RunResult;

export const runCommand: Runner = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
};

export function isCompanion(directory: string): boolean {
  return fs.existsSync(path.join(directory, COMPANION_CONFIG));
}

/**
 * The companions directory has to be readable and writable by the identity the
 * container runs as: the classic UID mismatch on a mounted volume, reported
 * here by name rather than discovered an hour later through a failed save.
 */
export function assertCompanionsDirUsable(companionsDir: string, identity: string): void {
  if (!fs.existsSync(companionsDir)) {
    throw new StartupError(
      `The companions directory ${companionsDir} does not exist. Mount it, or set MATE_COMPANIONS_DIR to where it is.`,
    );
  }
  if (!fs.statSync(companionsDir).isDirectory()) {
    throw new StartupError(`The companions directory ${companionsDir} is not a directory.`);
  }
  try {
    fs.accessSync(companionsDir, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new StartupError(
      `The companions directory ${companionsDir} is not readable by ${identity}, the identity this container runs as. Grant that identity access to the mounted volume.`,
    );
  }
  try {
    fs.accessSync(companionsDir, fs.constants.W_OK);
  } catch {
    throw new StartupError(
      `The companions directory ${companionsDir} is not writable by ${identity}, the identity this container runs as. Grant that identity access to the mounted volume.`,
    );
  }
}

function isEmptyDirectory(directory: string): boolean {
  if (!fs.existsSync(directory)) return true;
  return fs.readdirSync(directory).length === 0;
}

export function remoteOf(directory: string, run: Runner = runCommand): string | null {
  const result = run("git", ["-C", directory, "remote", "get-url", "origin"]);
  if (result.status !== 0) return null;
  const url = result.stdout.trim();
  return url === "" ? null : url;
}

/** Two spellings of the same remote should not read as a conflict. */
export function sameRemote(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/^ssh:\/\/git@/, "https://")
      .toLowerCase();
  return normalize(a) === normalize(b);
}

export interface CheckoutOutcome {
  location: GitLocation;
  destination: string;
  cloned: boolean;
}

/**
 * Clones each configured location only where its destination is empty. An
 * existing checkout is left exactly as it is; one that came from a different
 * remote is reported naming both, and never replaced.
 */
export function checkoutConfigured(
  companionsDir: string,
  locations: GitLocation[],
  run: Runner = runCommand,
): CheckoutOutcome[] {
  const outcomes: CheckoutOutcome[] = [];
  for (const location of locations) {
    const destination = path.join(companionsDir, location.directory);

    if (!isEmptyDirectory(destination)) {
      const existing = remoteOf(destination, run);
      if (existing !== null && !sameRemote(existing, location.url)) {
        throw new StartupError(
          `The checkout at ${destination} came from ${existing}, but the configuration names ${location.url}. ` +
            `Startup will not replace a checkout it did not make. Remove it, or point the configuration at the remote it came from.`,
        );
      }
      outcomes.push({ location, destination, cloned: false });
      continue;
    }

    const result = run("git", ["clone", location.url, destination]);
    if (result.status !== 0) {
      throw new StartupError(
        `Cloning ${location.url} into ${destination} failed: ${(result.stderr || result.stdout).trim() || `git exited ${result.status}`}`,
      );
    }
    outcomes.push({ location, destination, cloned: true });
  }
  return outcomes;
}

/** Every directory under the companions directory that carries a companion configuration. */
export function discoverCompanions(companionsDir: string): string[] {
  const found: string[] = [];
  // The companions directory may itself be a single companion, mounted directly.
  if (isCompanion(companionsDir)) return [path.resolve(companionsDir)];
  for (const entry of fs.readdirSync(companionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = path.join(companionsDir, entry.name);
    if (isCompanion(candidate)) found.push(path.resolve(candidate));
  }
  return found.sort();
}

/**
 * Which companion the session runs against. One is unambiguous; several
 * without a configured choice is reported with the candidates listed, rather
 * than chosen arbitrarily.
 */
export function selectCompanion(companions: string[], configured: string | null): string {
  if (companions.length === 0) {
    throw new StartupError(
      `No Companion Repository was found to serve. Mount one into the companions directory, or set MATE_COMPANION_REPOS to a Git location to check out.`,
    );
  }

  if (configured !== null) {
    const match = companions.find(
      (companion) =>
        companion === path.resolve(configured) || path.basename(companion) === configured,
    );
    if (!match) {
      throw new StartupError(
        `MATE_COMPANION names ${configured}, which is not among the companions found: ${companions.join(", ")}`,
      );
    }
    return match;
  }

  if (companions.length > 1) {
    throw new StartupError(
      `More than one Companion Repository was found and none was selected. Set MATE_COMPANION to one of: ${companions
        .map((companion) => path.basename(companion))
        .join(", ")}`,
    );
  }

  return companions[0]!;
}
