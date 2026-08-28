import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { readProjectionFile } from "../../runtime/projection";
import { repoLocalDirPath } from "../../runtime/repo-local";
import { companionGitSyncDeps } from "./companion-git-sync";
import type { GlobalConfigStore } from "./global-config-store";
import { projectionEntries } from "./projection-entries";
import {
  isExternalDocument,
  recordedRuntimeDocuments,
  removeRuntimeDocuments,
} from "./projection-runtime-documents";
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

/**
 * Which of the given repo-relative paths Git already has in its index. Asked
 * through the same runner the companion sync uses rather than a second spawn.
 * Best-effort by construction: a directory that is no repository, a Git that is
 * not installed, and a `ls-files` that fails for any other reason all answer
 * "nothing tracked" — this feeds a warning, and a warning may not fail a wrap.
 */
async function trackedDocuments(repoPath: string, documentPaths: string[]): Promise<string[]> {
  if (documentPaths.length === 0) return [];
  try {
    const result = await companionGitSyncDeps.runGit(
      ["ls-files", "-z", "--", ...documentPaths],
      path.resolve(repoPath),
    );
    if (result.status !== 0) return [];
    return result.stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The managed exclude block only hides a file Git does not already track, so a
 * repository that commits one of these documents keeps it in the index and the
 * regions land in a tracked file. Those regions carry machine-absolute
 * companion paths — keys naming directories under this user's home — so a
 * routine `git add -A` pushes one machine's layout to everyone else. Warn and
 * write anyway: refusing would silently drop the projection the repository was
 * wrapped for.
 *
 * Asked here rather than while rendering because the render also runs on every
 * launch; the wrap pass is the one that is a deliberate act, so this is the
 * scope where saying it once is information rather than noise.
 */
async function warnAboutTrackedDocuments(
  repository: LinkedRepository,
  runtimeDocuments: readonly RenderedRuntimeDocument[],
): Promise<void> {
  const tracked = await trackedDocuments(
    repository.path,
    runtimeDocuments
      .map((document) => document.path)
      .filter((documentPath) => !isExternalDocument(documentPath)),
  );
  for (const documentPath of tracked) {
    console.error(
      `${FRAMEWORK_NAME}: warning: ${documentPath} is tracked by Git in ${repository.id}; ${FRAMEWORK_NAME} writes machine-absolute companion paths into it, so committing it would push this machine's paths to everyone else on the repository.`,
    );
    console.error(
      `Untrack it with \`git rm --cached ${documentPath}\` if those paths should stay local.`,
    );
  }
}

export async function projectWorkingRuntimeDocuments(
  companionPath: string,
  repository: LinkedRepository,
  config: FrameworkConfig,
  runtimeDocuments: readonly RenderedRuntimeDocument[],
  globalConfigStore?: GlobalConfigStore,
): Promise<RuntimeDocumentsResult> {
  await warnAboutTrackedDocuments(repository, runtimeDocuments);
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
 * Whether `mate wrap` configured this Working Repository. Asked of the runtime
 * document manifest rather than of the Projection Root, because the root is not
 * evidence of a wrap: a launch and every Capability command write the
 * projection pair too. The manifest is written only by a pass that placed a
 * runtime document, and wrapping is the only pass that places one.
 */
export async function isWorkingRepositoryWrapped(repoPath: string): Promise<boolean> {
  return (await recordedRuntimeDocuments(repoPath)).length > 0;
}

export type UnwrapResult =
  | { kind: "unwrapped" | "absent"; documents: string[] }
  | { kind: "failed"; document: string; error: Error };

/**
 * The inverse of {@link projectWorkingRuntimeDocuments}, and only of that: the
 * runtime documents are withdrawn and the Projection Root, the Repository Link
 * and the companion link are left exactly as they were. That asymmetry with
 * `mate working cleanup` is the point — cleanup removes Mate's whole local
 * integration including the Repository Link, while unwrapping takes back only
 * what wrapping added, leaving a linked repository that was never wrapped. That
 * is what makes unwrapping the way back to a Managed Session rather than a
 * teardown.
 *
 * Driven by the manifest, so it withdraws whatever the wrap that ran recorded,
 * including a destination this release no longer renders.
 */
export async function unwrapWorkingRuntimeDocuments(repoPath: string): Promise<UnwrapResult> {
  const documents = await recordedRuntimeDocuments(repoPath);
  if (documents.length === 0) return { kind: "absent", documents: [] };

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
  return { kind: "unwrapped", documents: removed };
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
