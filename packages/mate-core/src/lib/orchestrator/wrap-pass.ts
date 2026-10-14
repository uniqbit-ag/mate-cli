import path from "node:path";

import { renderWorkingRuntimeDocuments } from "../../tools/setup";
import { renderAudienceLayer } from "../../tools/setup/audience-layer";
import { loadAudienceRegistrations } from "../../tools/setup/audience-registrations";
import { declaredAudiences } from "../../tools/setup/dynamic-plugins/audiences";
import { buildSetupInstallationPlan } from "../../tools/setup/engine";
import { getActiveDistribution } from "../../distribution";
import { audienceLayerDir } from "../../runtime/audience-layer";
import {
  readManifest,
  recordedAudience,
  updateManifest,
  withAudience,
} from "../../runtime/runtime-document-manifest";
import { readCompanionConfig } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import { entryFailureMessage, firstFailure, type ProjectionChangedPaths } from "./projection-types";
import type { WrapRuntime } from "../../runtime/runtime-document-manifest";
import { readWrapState, type WrapState } from "../../runtime/wrap-state";
import type { NormalizedRegistration } from "../../tools/setup/registry";
import type { FrameworkConfig, LinkedRepository } from "./types";
import { project } from "./working-repo-projection";

export interface WrapPassDependencies {
  renderWorkingRuntimeDocuments: typeof renderWorkingRuntimeDocuments;
  readCompanionConfig: typeof readCompanionConfig;
  project: typeof project;
  loadAudienceRegistrations: typeof loadAudienceRegistrations;
  renderAudienceLayer: typeof renderAudienceLayer;
  /** The registered companions, whose stale skill links a re-pin withdraws; the user's registry when absent. */
  globalConfigStore?: GlobalConfigStore;
}

export const wrapPassDeps: WrapPassDependencies = {
  renderWorkingRuntimeDocuments,
  readCompanionConfig,
  project,
  loadAudienceRegistrations,
  renderAudienceLayer,
};

export interface WrapPassOptions {
  /** Reconcile only these runtimes; every active runtime when absent. */
  runtimes?: readonly WrapRuntime[];
  /** The companion config the caller already read; read from files otherwise. */
  config?: FrameworkConfig;
  /**
   * The audience to wrap the checkout for: a name records it, `null` withdraws
   * it, absent keeps the one the manifest records. Never read from the
   * environment: it is the only source of a bare session's audience.
   */
  audience?: string | null;
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
      /** Active runtimes whose tagged entries this pass ran; never inferred from paths. */
      runtimes: ReadonlySet<WrapRuntime>;
      /** The wrap state as this pass left it. */
      wrapState: WrapState;
      /** The audience the checkout is wrapped for after this pass. */
      audience: string | null;
    }
  | { kind: "failed"; message: string };

/** An audience a checkout may be wrapped for: declared by the companion, never the reserved base. */
function wrappableAudience(config: FrameworkConfig, audience: string): boolean {
  return audience !== "base" && declaredAudiences(config).includes(audience);
}

function describeUnwrappable(config: FrameworkConfig, audience: string): string {
  const declared = declaredAudiences(config).filter((name) => name !== "base");
  return `audience "${audience}" cannot be wrapped: the companion declares ${declared.length > 0 ? declared.join(", ") : "no audiences"}.`;
}

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

  const audienceWarnings: string[] = [];
  let audience: string | null;
  if (options.audience === undefined) {
    const recorded = recordedAudience(await readManifest(repository.path));
    /** A recorded audience the companion no longer declares falls back to base, never fails a prepare. */
    if (recorded && !wrappableAudience(config, recorded)) {
      audienceWarnings.push(
        `${describeUnwrappable(config, recorded)} ${repository.id} is wrapped for base only.`,
      );
      audience = null;
    } else {
      audience = recorded;
    }
  } else {
    audience = options.audience;
    if (audience && !wrappableAudience(config, audience)) {
      return { kind: "failed", message: describeUnwrappable(config, audience) };
    }
  }

  let wrapped: { audience: string; registrations: NormalizedRegistration[] } | undefined;
  if (audience) {
    const loaded = await deps.loadAudienceRegistrations(resolvedCompanionPath, config, audience);
    audienceWarnings.push(...loaded.warnings);
    await deps.renderAudienceLayer({
      companionPath: resolvedCompanionPath,
      config,
      audience,
      activeProviders: buildSetupInstallationPlan(
        config,
        getActiveDistribution().registry.baseRegistrations(),
      ).activeProviders,
      registrations: loaded.registrations,
    });
    wrapped = { audience, registrations: loaded.registrations };
  }

  const rendered = await deps.renderWorkingRuntimeDocuments(
    resolvedCompanionPath,
    config,
    repository.path,
    undefined,
    wrapped,
  );
  const result = await deps.project("wrap", {
    repoPath: repository.path,
    companionPath: resolvedCompanionPath,
    repository,
    config,
    runtimeDocuments: rendered.documents,
    audienceLayerDir: audience ? audienceLayerDir(resolvedCompanionPath, audience) : null,
    globalConfigStore: deps.globalConfigStore ?? new GlobalConfigStore(),
    ...(options.runtimes ? { runtimes: options.runtimes } : {}),
  });

  const failure = firstFailure(result.outcomes);
  if (failure) return { kind: "failed", message: entryFailureMessage(failure, repository.id) };

  const before = recordedAudience(await readManifest(repository.path));
  const audienceChanged = before !== audience;
  if (audienceChanged) {
    await updateManifest(repository.path, (manifest) => withAudience(manifest, audience));
  }

  /** Read once under the caller's lock, so it is exactly what the pass recorded. */
  let wrapState: WrapState;
  try {
    wrapState = await readWrapState(repository.path);
  } catch (error) {
    return {
      kind: "failed",
      message: `could not read the runtime document manifest for ${repository.id}: ${(error as Error).message}`,
    };
  }
  /** Inactive runtimes' entries run too, to withdraw; that is not covering them. */
  const active = new Set(config.allowedAgents ?? []);
  const runtimes = new Set(
    result.outcomes.flatMap((outcome) =>
      outcome.runtime && outcome.state !== "skipped" && active.has(outcome.runtime)
        ? [outcome.runtime]
        : [],
    ),
  );

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
    kind:
      audienceChanged || result.outcomes.some((outcome) => outcome.state === "written")
        ? "written"
        : "current",
    projectionRoot: result.root,
    companionPath: resolvedCompanionPath,
    documents: [...new Set(documents)],
    writtenDocuments: [...new Set(writtenDocuments)],
    changed: {
      written: result.outcomes.flatMap((outcome) => outcome.changed?.written ?? []),
      removed: result.outcomes.flatMap((outcome) => outcome.changed?.removed ?? []),
    },
    warnings: [
      ...audienceWarnings,
      ...rendered.warnings,
      ...result.outcomes.flatMap((outcome) => outcome.warnings ?? []),
      /** A degradable failure does not fail the pass, but it is never silent. */
      ...result.outcomes
        .filter((outcome) => outcome.state === "failed" && outcome.degradable)
        .map((outcome) => entryFailureMessage(outcome, repository.id)),
    ],
    runtimes,
    wrapState,
    audience,
  };
}
