import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import {
  CompanionResolver,
  type CompanionMatch,
} from "../../../lib/orchestrator/companion-resolver";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { findRepoLocalLinkedRepository } from "../../../lib/orchestrator/repo-local-registry";
import { projectWorkingRepositoryBestEffort } from "../../../lib/orchestrator/working-repo-projection";
import { resolveProjection } from "../../../runtime/projection";
import { selectCompanion } from "../../companion-selector";

export const launchAmbiguityDeps = {
  resolveCompanionMatches: async (cwd: string) =>
    (await new CompanionResolver(new GlobalConfigStore()).resolveWithDiagnostics(cwd))
      .ambiguousMatches,
  /**
   * The resolver reports `ambiguousMatches` as `[]` for an unambiguous link, so
   * the Linked Companions are that list when populated and the single match
   * otherwise.
   */
  resolveLinkedCompanions: async (cwd: string): Promise<CompanionMatch[]> => {
    const { match, ambiguousMatches } = await new CompanionResolver(
      new GlobalConfigStore(),
    ).resolveWithDiagnostics(cwd);
    if (ambiguousMatches.length > 0) return ambiguousMatches;
    return match ? [match] : [];
  },
  selectCompanion,
  findRepoLocalLinkedRepository,
  resolveProjection,
  projectWorkingRepository: projectWorkingRepositoryBestEffort,
};

export interface CompanionSelectionOptions {
  /** Ignore both recorded answers — the launch environment and the projection. */
  reselect?: boolean;
  /** Ignore only the projected answer, so an ambiguous repository is asked again. */
  ignoreProjection?: boolean;
  /** Outranks the environment, the projection, and the picker. */
  companion?: string;
}

function pin(match: Pick<CompanionMatch, "companionPath" | "repositoryId">): void {
  process.env.MATE_ARTIFACT_PATH = match.companionPath;
  process.env.MATE_REPO_ID = match.repositoryId;
}

function reportLinkedCompanions(message: string, matches: CompanionMatch[]): void {
  process.stderr.write(message);
  for (const match of matches) {
    process.stderr.write(`  - ${match.companionPath}\n`);
  }
}

/**
 * Rank 1. Validated against the Linked Companions so a wrap can never record a
 * companion that does not link the Working Repository.
 */
async function pinExplicitCompanion(cwd: string, companion: string): Promise<boolean> {
  const resolved = path.resolve(companion);
  const linked = await launchAmbiguityDeps.resolveLinkedCompanions(cwd);
  const chosen = linked.find((match) => path.resolve(match.companionPath) === resolved);
  if (!chosen) {
    reportLinkedCompanions(
      `${FRAMEWORK_NAME}: ${resolved} does not link this working repo; linked companions are:\n`,
      linked,
    );
    return false;
  }

  pin(chosen);
  return true;
}

/**
 * Rank 3. Only reached when the link is ambiguous, so `matches` is the full set
 * of Linked Companions — a projected companion absent from it no longer links
 * the repository and is ignored rather than pinning a dead path.
 */
function projectedCompanion(cwd: string, matches: CompanionMatch[]): CompanionMatch | null {
  const projected = launchAmbiguityDeps.resolveProjection(cwd);
  if (!projected) return null;

  const resolved = path.resolve(projected.companionPath);
  return matches.find((match) => path.resolve(match.companionPath) === resolved) ?? null;
}

/** Best-effort: a read-only Working Repository warns and the command proceeds. */
async function recordCompanion(cwd: string, chosen: CompanionMatch): Promise<void> {
  const repository = await launchAmbiguityDeps.findRepoLocalLinkedRepository(cwd);
  if (!repository) return;

  await launchAmbiguityDeps.projectWorkingRepository(chosen.companionPath, repository);
}

/**
 * Pins a companion selection into env vars when the current working repo is
 * linked from multiple companions. Commands that should respect an already
 * selected companion can call this before any context resolution. Resolution
 * order: explicit companion, launch environment, Projection Root, picker — the
 * environment above the projection, so no projection can degrade a session Mate
 * configured. A picked companion is recorded at the Projection Root, so the
 * question is asked once rather than once per command.
 */
export async function ensureUnambiguousCompanion(
  cwd: string = process.cwd(),
  options: CompanionSelectionOptions = {},
): Promise<boolean> {
  if (options.companion) return pinExplicitCompanion(cwd, options.companion);
  if (process.env.MATE_ARTIFACT_PATH && !options.reselect) return true;

  const ambiguousMatches = await launchAmbiguityDeps.resolveCompanionMatches(cwd);
  if (ambiguousMatches.length <= 1) return true;

  if (!options.reselect && !options.ignoreProjection) {
    const projected = projectedCompanion(cwd, ambiguousMatches);
    if (projected) {
      pin(projected);
      return true;
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    reportLinkedCompanions(
      `${FRAMEWORK_NAME}: this working repo is linked from multiple companions; re-run in a TTY to choose one, run \`${FRAMEWORK_NAME} wrap --companion <path>\`, or set MATE_ARTIFACT_PATH.\n`,
      ambiguousMatches,
    );
    return false;
  }

  const chosen = await launchAmbiguityDeps.selectCompanion(ambiguousMatches);
  if (!chosen) {
    process.stderr.write("Aborted.\n");
    return false;
  }

  pin(chosen);
  await recordCompanion(cwd, chosen);
  return true;
}
