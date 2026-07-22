import type { CapabilityConfig, LinkedRepository } from "../../../../lib/orchestrator/types";

export interface FinishContext {
  companionPath: string;
  repositoryId: string;
  repository?: LinkedRepository;
}

/**
 * The committable result of a finisher's terminal transform: what anchor the tag is
 * derived from and which paths the finish commit is scoped to.
 */
export interface Produced {
  /** Dated/immutable anchor the tag mirrors, e.g. `2026-07-14-my-change`. */
  anchorName: string;
  /** Pathspecs the finish commit stages — and nothing outside them. */
  commitPaths: string[];
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
}

export interface CompleteResult {
  complete: boolean;
  total: number;
  remaining: number;
}

export interface ProduceResult {
  ok: boolean;
  produced: Produced | null;
  message: string;
}

/**
 * The variable, per-artifact-kind half of `mate artifact finish`. The engine
 * ({@link ../engine}) owns everything type-agnostic — scoped rollback,
 * commit, remote-sync, conflict handoff, tag, push. A finisher supplies only what
 * differs between artifact kinds (openspec changes today; ADRs, etc. later).
 */
export interface ArtifactFinisher {
  /** Selector key, e.g. `openspec`. */
  readonly type: string;
  /** Message shown when {@link isEnabled} is false (the no-op-with-message case). */
  readonly disabledReason: string;
  /** Gate: is this finisher usable in the resolved capability set? */
  isEnabled(capabilities: CapabilityConfig[]): boolean;
  /** Never-bypassable guard. Not run when resuming an already-produced artifact. */
  validate(name: string): Promise<ValidateResult>;
  /** `--force`-overridable guard. Not run when resuming. */
  isComplete(name: string): Promise<CompleteResult>;
  /**
   * Resumable detection: return the already-produced artifact (developer ran the
   * transform by hand, or a prior finish half-completed) so the engine skips
   * {@link produce} and continues to commit → tag → push, or null if not yet produced.
   */
  detectProduced(name: string): Promise<Produced | null>;
  /** The terminal transform that yields committable outputs (openspec archive; …). */
  produce(name: string): Promise<ProduceResult>;
  /** Optional capability sync scoped to this finisher; resolves false on failure. */
  capSync?(): Promise<boolean>;
}

export type FinisherFactory = (context: FinishContext) => ArtifactFinisher;
