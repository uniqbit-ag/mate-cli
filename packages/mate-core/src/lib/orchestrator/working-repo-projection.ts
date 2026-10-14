import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { readProjectionFile } from "../../runtime/projection";
import { GlobalConfigStore } from "./global-config-store";
import { repoLocalDirPath } from "../../runtime/repo-local";
import { projectionEntries } from "./projection-entries";
import {
  copies as recordedCopies,
  documents as recordedDocuments,
  readManifest,
} from "../../runtime/runtime-document-manifest";
import { removeRuntimeDocuments } from "./projection-runtime-documents";
import {
  firstFailure,
  type ProjectionDescription,
  type ProjectionEntry,
  type ProjectionEntryOutcome,
  type ProjectionEntryPresence,
  type ProjectionInput,
  type ProjectionRemovalInput,
  type ProjectionRemovalResult,
  type ProjectionResult,
  type ProjectionScope,
  type ProjectionWriteReport,
  type ProjectionWriteState,
} from "./projection-types";
import type { LinkedRepository } from "./types";

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
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
  };
}

/** One outcome shape for both forms a write may return; empty reports are omitted. */
function writeOutcome(
  entry: ProjectionEntry,
  written: ProjectionWriteState | ProjectionWriteReport,
): ProjectionEntryOutcome {
  if (typeof written === "string") return outcome(entry, written);
  const { state, warnings = [], changed } = written;
  const anyChanged = changed && (changed.written.length > 0 || changed.removed.length > 0);
  return {
    ...outcome(entry, state),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(anyChanged ? { changed } : {}),
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
  const runtimes = input.runtimes ? new Set(input.runtimes) : null;
  for (const entry of projectionEntries()) {
    if (!entry.scopes.includes(scope)) continue;
    if (entry.runtime && runtimes && !runtimes.has(entry.runtime)) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- catalogue order is the contract
      outcomes.push(writeOutcome(entry, await entry.write(input))); // react-doctor-disable-line react-doctor/async-await-in-loop
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
  for (const entry of projectionEntries().toReversed()) {
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
      const removed = outcome(entry, await removal.remove(input));
      outcomes.push(removal.retains ? { ...removed, retains: removal.retains } : removed);
    } catch (error) {
      outcomes.push(outcome(entry, "failed", toError(error)));
    }
  }
  return { root: repoLocalDirPath(input.repoPath), outcomes };
}

/**
 * Removes entries that wrap owns but an unwrap must withdraw independently.
 * Sequential: several of them rewrite the manifest, and concurrent rewrites
 * would restore each other's withdrawn records.
 */
async function removeWorkingRepositoryUnwrapEntries(
  repoPath: string,
  registeredCompanionPaths: string[],
): Promise<ProjectionEntryOutcome[]> {
  const outcomes: ProjectionEntryOutcome[] = [];
  for (const entry of projectionEntries()) {
    const removal = entry.removal;
    if (!entry.removeOnUnwrap || removal.by !== "self") continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each removal rewrites the manifest
      outcomes.push(outcome(entry, await removal.remove({ repoPath, registeredCompanionPaths }))); // react-doctor-disable-line react-doctor/async-await-in-loop
    } catch (error) {
      outcomes.push(outcome(entry, "failed", toError(error)));
    }
  }
  return outcomes;
}

/** Reads and reports; writes nothing. Freshness is a verdict above this module. */
export async function describe(repoPath: string): Promise<ProjectionDescription> {
  const entries: ProjectionEntryPresence[] = await Promise.all(
    projectionEntries().map(async (entry) => {
      const present = await (entry.present
        ? entry.present(repoPath)
        : fs
            .access(path.join(path.resolve(repoPath), entry.path))
            .then(() => true)
            .catch(() => false));
      return { id: entry.id, path: entry.path, kind: entry.kind, present };
    }),
  );
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

export type UnwrapResult =
  | { kind: "unwrapped" | "absent"; documents: string[]; copies: string[] }
  | { kind: "failed"; document: string; error: Error };

/**
 * The inverse of a wrap's runtime documents: runtime documents and
 * projected Claude skill links are withdrawn while the Projection Root, the
 * Repository Link and the companion link are left exactly as they were. That
 * asymmetry with `mate working cleanup` is the point — cleanup removes Mate's
 * whole local integration including the Repository Link, while unwrapping takes
 * back only what wrapping added, leaving a linked repository that was never
 * wrapped. That is what makes unwrapping the way back to a Managed Session
 * rather than a teardown.
 *
 * Driven by the manifest, so it withdraws whatever the wrap that ran recorded,
 * including a destination this release no longer renders.
 */
export async function unwrapWorkingRuntimeDocuments(
  repoPath: string,
  globalConfigStore: GlobalConfigStore = new GlobalConfigStore(),
): Promise<UnwrapResult> {
  const manifest = await readManifest(repoPath);
  const documents = recordedDocuments(manifest);
  const copies = Object.keys(recordedCopies(manifest));
  const removeWrapEntries = async (): Promise<ProjectionEntryOutcome[]> =>
    removeWorkingRepositoryUnwrapEntries(repoPath, await globalConfigStore.list());
  if (documents.length === 0) {
    const outcomes = await removeWrapEntries();
    const failure = firstFailure(outcomes);
    if (failure) {
      return {
        kind: "failed",
        document: failure.path,
        error: failure.error ?? new Error("wrap entry removal failed"),
      };
    }
    return outcomes.some((entry) => entry.state === "removed")
      ? { kind: "unwrapped", documents: [], copies }
      : { kind: "absent", documents: [], copies: [] };
  }

  /**
   * One manifest read and one manifest write for the whole withdrawal. A
   * per-document call could not be run concurrently — each rewrites the whole
   * manifest, so the last write would restore the keys the others removed, and
   * a surviving key reads back as still wrapped — leaving a launch refused after
   * a successful unwrap.
   */
  const { removed, error } = await removeRuntimeDocuments(repoPath, documents);
  /** Reported after the successful withdrawals are already durable. */
  if (error) return { kind: "failed", document: error.document, error: error.error };
  const outcomes = await removeWrapEntries();
  const failure = firstFailure(outcomes);
  if (failure) {
    return {
      kind: "failed",
      document: failure.path,
      error: failure.error ?? new Error("wrap entry removal failed"),
    };
  }
  return { kind: "unwrapped", documents: removed, copies };
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
