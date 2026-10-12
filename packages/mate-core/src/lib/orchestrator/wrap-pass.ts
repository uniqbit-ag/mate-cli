import path from "node:path";

import { renderWorkingRuntimeDocuments } from "../../tools/setup";
import { readCompanionConfig } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import { entryFailureMessage, firstFailure, type ProjectionChangedPaths } from "./projection-types";
import type { WrapRuntime } from "../../runtime/runtime-document-manifest";
import type { FrameworkConfig, LinkedRepository } from "./types";
import { project } from "./working-repo-projection";

export interface WrapPassDependencies {
  renderWorkingRuntimeDocuments: typeof renderWorkingRuntimeDocuments;
  readCompanionConfig: typeof readCompanionConfig;
  project: typeof project;
  /** The registered companions, whose stale skill links a re-pin withdraws; the user's registry when absent. */
  globalConfigStore?: GlobalConfigStore;
}

export const wrapPassDeps: WrapPassDependencies = {
  renderWorkingRuntimeDocuments,
  readCompanionConfig,
  project,
};

export interface WrapPassOptions {
  /** Reconcile only these runtimes; every active runtime when absent. */
  runtimes?: readonly WrapRuntime[];
  /** The companion config the caller already read; read from files otherwise. */
  config?: FrameworkConfig;
}

export type WrapPassResult =
  | {
      kind: "written" | "current";
      projectionRoot: string;
      companionPath: string;
      /** The runtime documents this pass answered for, written or current. */
      documents: string[];
      /** The subset of `documents` this pass wrote. */
      writtenDocuments: string[];
      /** Every path an entry reported writing or withdrawing one by one. */
      changed: ProjectionChangedPaths;
      /** The render's warnings, then every entry's, for the caller to present. */
      warnings: string[];
    }
  | { kind: "failed"; message: string };

/**
 * One pass of the `wrap` scope, restricted to the requested runtimes by each
 * entry's runtime tag. Best-effort per entry like every projection: a failed
 * entry fails the pass while whatever the other entries wrote stays in place.
 */
export async function runWrapPass(
  companionPath: string,
  repository: LinkedRepository,
  options: WrapPassOptions = {},
  deps: WrapPassDependencies = wrapPassDeps,
): Promise<WrapPassResult> {
  const resolvedCompanionPath = path.resolve(companionPath);
  const config = options.config ?? (await deps.readCompanionConfig(resolvedCompanionPath));
  const rendered = await deps.renderWorkingRuntimeDocuments(
    resolvedCompanionPath,
    config,
    repository.path,
  );
  const result = await deps.project("wrap", {
    repoPath: repository.path,
    companionPath: resolvedCompanionPath,
    repository,
    config,
    runtimeDocuments: rendered.documents,
    globalConfigStore: deps.globalConfigStore ?? new GlobalConfigStore(),
    ...(options.runtimes ? { runtimes: options.runtimes } : {}),
  });

  const failure = firstFailure(result.outcomes);
  if (failure) return { kind: "failed", message: entryFailureMessage(failure, repository.id) };

  /** The destinations the surfaces rendered; the rest of the pass is scaffolding. */
  const destinations = new Set(
    rendered.documents.map((document) => document.path.split("/").join(path.sep)),
  );
  const placed = result.outcomes.filter((outcome) => destinations.has(outcome.path));
  const documents = placed.map((outcome) => outcome.path);
  const writtenDocuments = placed
    .filter((outcome) => outcome.state === "written")
    .map((outcome) => outcome.path);

  return {
    kind: result.outcomes.some((outcome) => outcome.state === "written") ? "written" : "current",
    projectionRoot: result.root,
    companionPath: resolvedCompanionPath,
    documents: [...new Set(documents)],
    writtenDocuments: [...new Set(writtenDocuments)],
    changed: {
      written: result.outcomes.flatMap((outcome) => outcome.changed?.written ?? []),
      removed: result.outcomes.flatMap((outcome) => outcome.changed?.removed ?? []),
    },
    warnings: [
      ...rendered.warnings,
      ...result.outcomes.flatMap((outcome) => outcome.warnings ?? []),
    ],
  };
}
