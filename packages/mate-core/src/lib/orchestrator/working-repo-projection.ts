import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { readProjectionFile } from "../../runtime/projection";
import { repoLocalDirPath } from "../../runtime/repo-local";
import type { GlobalConfigStore } from "./global-config-store";
import { projectionEntries } from "./projection-entries";
import {
  firstFailure,
  type RenderedRuntimeDocument,
  type ProjectionDescription,
  type ProjectionEntry,
  type ProjectionEntryOutcome,
  type ProjectionEntryPresence,
  type ProjectionInput,
  type ProjectionRemovalInput,
  type ProjectionRemovalResult,
  type ProjectionResult,
  type ProjectionScope,
} from "./projection-types";
import type { FrameworkConfig, LinkedRepository } from "./types";

/**
 * The owner of the Managed Projection: every path Mate places inside a Working
 * Repository is written and removed from here, through the declarations in
 * `projection-entries.ts`. This module holds no Agent Runtime format knowledge —
 * that is what keeps a second runtime writing the same destination a new
 * declaration rather than a branch in here.
 */

export type ProjectionWriteResult =
  | { kind: "written"; projectionRoot: string; companionPath: string }
  | { kind: "current"; projectionRoot: string; companionPath: string }
  | { kind: "failed"; error: Error };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function outcome(
  entry: ProjectionEntry,
  state: ProjectionEntryOutcome["state"],
  error?: Error,
): ProjectionEntryOutcome {
  return {
    id: entry.id,
    path: entry.path,
    kind: entry.kind,
    state,
    ...(error ? { error } : {}),
    ...(entry.degradable ? { degradable: true } : {}),
  };
}

/**
 * Writes the entries the scope declares, in catalogue order so the managed
 * exclude block precedes anything it covers. Best-effort per entry: one failure
 * neither aborts the rest nor throws, so a caller that must fail reads the
 * reported outcomes instead.
 */
export async function project(
  scope: ProjectionScope,
  input: ProjectionInput,
): Promise<ProjectionResult> {
  const outcomes: ProjectionEntryOutcome[] = [];
  for (const entry of projectionEntries()) {
    if (!entry.scopes.includes(scope)) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- catalogue order is the contract
      outcomes.push(outcome(entry, await entry.write(input)));
    } catch (error) {
      outcomes.push(outcome(entry, "failed", toError(error)));
    }
  }
  return { root: repoLocalDirPath(input.repoPath), scope, outcomes };
}

/**
 * Removes every declared entry regardless of which scope wrote it, walking the
 * catalogue in reverse. An entry covered by another entry's removal, or
 * deliberately retained, is reported as such rather than being silently absent.
 */
export async function unproject(input: ProjectionRemovalInput): Promise<ProjectionRemovalResult> {
  const outcomes: ProjectionEntryOutcome[] = [];
  for (const entry of [...projectionEntries()].reverse()) {
    const { removal } = entry;
    if (removal.by === "entry") {
      outcomes.push(outcome(entry, "covered"));
      continue;
    }
    if (removal.by === "retained") {
      outcomes.push(outcome(entry, "retained"));
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- reverse catalogue order is the contract
      outcomes.push(outcome(entry, await removal.remove(input)));
    } catch (error) {
      outcomes.push(outcome(entry, "failed", toError(error)));
    }
  }
  return { root: repoLocalDirPath(input.repoPath), outcomes };
}

/** Reads and reports; writes nothing. Freshness is a verdict above this module. */
export async function describe(repoPath: string): Promise<ProjectionDescription> {
  const entries: ProjectionEntryPresence[] = [];
  for (const entry of projectionEntries()) {
    const present = entry.present
      ? // oxlint-disable-next-line no-await-in-loop -- reported in catalogue order
        await entry.present(repoPath)
      : await fs
          .access(path.join(path.resolve(repoPath), entry.path))
          .then(() => true)
          .catch(() => false);
    entries.push({ id: entry.id, path: entry.path, kind: entry.kind, present });
  }
  return {
    root: repoLocalDirPath(repoPath),
    entries,
    projection: readProjectionFile(repoPath),
  };
}

/**
 * Makes the Managed Projection durable at the Working Repository's Projection
 * Root so an Unmanaged Session can resolve it from files. Reports its outcome
 * rather than swallowing it: callers that asked for the write explicitly need
 * to fail on it, while resolution paths stay best-effort through the wrapper
 * below. Callers must have established that the companion is not a guess.
 */
export async function projectWorkingRepository(
  companionPath: string,
  repository: LinkedRepository,
): Promise<ProjectionWriteResult> {
  const resolvedCompanionPath = path.resolve(companionPath);
  const result = await project("session", {
    repoPath: repository.path,
    companionPath: resolvedCompanionPath,
    repository,
  });

  const failure = firstFailure(result.outcomes);
  if (failure) return { kind: "failed", error: failure.error ?? new Error("projection failed") };

  /** The projection pair is what "the projection" means to these callers. */
  const pair = result.outcomes.find((candidate) => candidate.id === "projection-pair");
  return {
    kind: pair?.state === "written" ? "written" : "current",
    projectionRoot: result.root,
    companionPath: resolvedCompanionPath,
  };
}

/**
 * The rendered runtime documents, placed. Reported per document because the
 * operator asked for these by name: a failure has to say which one failed while
 * the projection already written stays where it is.
 */
export type RuntimeDocumentsResult =
  | { kind: "written" | "current"; documents: string[] }
  | { kind: "failed"; document: string; error: Error };

export async function projectWorkingRuntimeDocuments(
  companionPath: string,
  repository: LinkedRepository,
  config: FrameworkConfig,
  runtimeDocuments: readonly RenderedRuntimeDocument[],
  globalConfigStore?: GlobalConfigStore,
): Promise<RuntimeDocumentsResult> {
  const result = await project("wrap", {
    repoPath: repository.path,
    companionPath: path.resolve(companionPath),
    repository,
    config,
    runtimeDocuments,
    globalConfigStore,
  });

  const failure = firstFailure(result.outcomes);
  if (failure) {
    return {
      kind: "failed",
      document: failure.path,
      error: failure.error ?? new Error("runtime document write failed"),
    };
  }

  /** The destinations the caller handed over; the rest of the pass is scaffolding. */
  const destinations = new Set(
    runtimeDocuments.map((document) => document.path.split("/").join(path.sep)),
  );
  const outcomes = result.outcomes.filter((outcome) => destinations.has(outcome.path));
  return {
    kind: outcomes.some((outcome) => outcome.state === "written") ? "written" : "current",
    documents: [...new Set(outcomes.map((outcome) => outcome.path))],
  };
}

/**
 * Best-effort like `backfillCompanionRegistration`: a read-only Working
 * Repository warns and the caller still proceeds.
 */
export async function projectWorkingRepositoryBestEffort(
  companionPath: string,
  repository: LinkedRepository,
): Promise<ProjectionWriteResult> {
  const result = await projectWorkingRepository(companionPath, repository);
  if (result.kind === "failed") {
    console.error(
      `${FRAMEWORK_NAME}: warning: failed to write the projection for ${repository.id}: ${result.error.message}`,
    );
  }
  return result;
}
