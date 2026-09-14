import type { CapabilityConfig, LinkedRepository } from "../../../../lib/orchestrator/types";

export interface FinishContext {
  companionPath: string;
  repositoryId: string;
  repository?: LinkedRepository;
}

/**
 * The committable result of resolving a publication target: what anchor the tag is
 * derived from and which paths the publication commit is scoped to.
 */
export interface Produced {
  /** Dated/immutable anchor the tag mirrors, e.g. `2026-07-14-my-change`. */
  anchorName: string;
  /** Pathspecs the publication commit stages — and nothing outside them. */
  commitPaths: string[];
}

/** Outcome of {@link ArtifactFinisher.resolve}; the failure carries the user-facing refusal. */
export type ResolveResult = { ok: true; resolved: Produced } | { ok: false; message: string };

/**
 * The variable, per-artifact-kind half of `mate artifact publish`. The engine
 * ({@link ../engine}) owns everything type-agnostic — branch guard, commit,
 * remote-sync, conflict handoff, tag, push. A finisher supplies only what differs
 * between artifact kinds (openspec changes today; ADRs, etc. later).
 *
 * Producing the artifact is not part of the interface: the archive-equivalent step
 * for every artifact kind is its own workflow, and publishing is terminal over it.
 */
export interface ArtifactFinisher {
  /** Selector key, e.g. `openspec`. */
  readonly type: string;
  /** Message shown when {@link isEnabled} is false (the no-op-with-message case). */
  readonly disabledReason: string;
  /** Gate: is this finisher usable in the resolved capability set? */
  isEnabled(capabilities: CapabilityConfig[]): boolean;
  /**
   * Resolve a target — a dated anchor or an unambiguous artifact name — to the already
   * produced outputs. Mutates nothing a failure would have to undo.
   */
  resolve(target: string): Promise<ResolveResult>;
  /** Optional capability sync scoped to this finisher; resolves false on failure. */
  capSync?(): Promise<boolean>;
}

export type FinisherFactory = (context: FinishContext) => ArtifactFinisher;
