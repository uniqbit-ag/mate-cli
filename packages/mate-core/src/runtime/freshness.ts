import fs from "node:fs";

import { mateInstallPath, mateVersion } from "./install";
import { computeProjectionStamp, type ResolvedProjection } from "./projection";
import { repoLocalRegistryPath } from "./repo-local";

/**
 * Two independent axes. A stamp answers only "was this written by a mate that
 * isn't me"; it cannot see a moved or deleted companion, because
 * `companionPath` is not a stamp input.
 */
export interface ProjectionFreshness {
  stampCurrent: boolean;
  companionExists: boolean;
  isCurrent: boolean;
}

export function projectionFreshness(projection: ResolvedProjection): ProjectionFreshness {
  const registryContent = (() => {
    try {
      return fs.readFileSync(repoLocalRegistryPath(projection.repoRoot), "utf8");
    } catch {
      return "";
    }
  })();

  const stampCurrent =
    projection.stamp ===
    computeProjectionStamp({
      version: mateVersion(),
      installPath: mateInstallPath(),
      registryContent,
    });

  const companionExists = (() => {
    try {
      return fs.statSync(projection.companionPath).isDirectory();
    } catch {
      return false;
    }
  })();

  return { stampCurrent, companionExists, isCurrent: stampCurrent && companionExists };
}

/**
 * Advisory, never fatal: a reader surfaces these and carries on. Stale is the
 * steady state under wrap-once, so the repair is named rather than enforced.
 */
export function projectionStalenessLines(
  projection: ResolvedProjection,
  freshness: ProjectionFreshness,
): string[] {
  const lines: string[] = [];
  if (!freshness.stampCurrent) {
    lines.push("projection was written by a different mate install — run `mate wrap` to refresh");
  }
  if (!freshness.companionExists) {
    lines.push(`projected companion is missing: ${projection.companionPath} — run \`mate wrap\``);
  }
  return lines;
}
