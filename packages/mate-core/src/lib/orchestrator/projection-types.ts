import type { GlobalConfigStore } from "./global-config-store";
import type { ProjectionFile } from "../../runtime/projection";
import type { CompanionSource, FrameworkConfig, LinkedRepository } from "./types";

/**
 * `owned` — Mate created the whole path; removal deletes it. `merged` — Mate
 * maintains a marked region inside a path a human may also author; removal
 * strips exactly that region and rewrites nothing else.
 */
export type ProjectionEntryKind = "owned" | "merged";

/**
 * What the caller is doing, not which files it wants. The entry set cannot be
 * derived from the inputs: recording a Repository Link holds a companion and a
 * repository yet deliberately writes no projection, because wrapping is an
 * explicit act.
 */
export type ProjectionScope = "link" | "session" | "launch" | "workspace" | "wrap";

export type ProjectionEntryId =
  | "git-excludes"
  | "projection-root"
  | "companion-link"
  | "repo-local-framework"
  | "repo-local-registry"
  | "projection-pair"
  | "workspace-document"
  | "capability-excludes"
  | "claude-working-settings"
  | "legacy-tokensave-claude-md"
  | "claude-runtime-document"
  | "mcp-runtime-document"
  | "opencode-runtime-document";

/**
 * A region of a runtime document that Mate maintains. JSON carries no comment
 * syntax, so the region is recorded rather than marked in the file: `list`
 * appends values not already there, `map` sets entries by key, `value` sets one
 * key — and removal takes back exactly those, leaving anything a human added.
 */
export type ManagedRegion =
  | { readonly at: string[]; readonly kind: "list"; readonly values: unknown[] }
  | { readonly at: string[]; readonly kind: "map"; readonly entries: Record<string, unknown> }
  | { readonly at: string[]; readonly kind: "value"; readonly value: unknown };

/**
 * What a Runtime Surface hands the Projection Root: the managed content of one
 * document, without a destination. The surface renders; the entry places.
 */
export interface RenderedRuntimeDocument {
  /** Repo-relative, POSIX separators. */
  readonly path: string;
  readonly regions: readonly ManagedRegion[];
}

export interface ProjectionInput {
  repoPath: string;
  companionPath?: string;
  repository?: LinkedRepository;
  source?: CompanionSource;
  config?: FrameworkConfig;
  /** Which companion paths Mate registered; injectable so fixtures stay hermetic. */
  globalConfigStore?: GlobalConfigStore;
  /** Rendered by the active Runtime Surfaces; placed by the `wrap` scope's entries. */
  runtimeDocuments?: readonly RenderedRuntimeDocument[];
}

export interface ProjectionRemovalInput {
  repoPath: string;
  /** Companion paths Mate registered; only those are Mate's to strip. */
  registeredCompanionPaths?: string[];
}

export type ProjectionWriteState = "written" | "current" | "skipped";
export type ProjectionRemoveState = "removed" | "absent" | "retained" | "covered";

/**
 * Every entry names its inverse. `self` removes its own path, `entry` is covered
 * by another entry's removal, `retained` is deliberately left behind and says
 * why — so a path is never merely absent from removal.
 */
export type ProjectionEntryRemoval =
  | {
      readonly by: "self";
      remove(input: ProjectionRemovalInput): Promise<"removed" | "absent">;
    }
  | { readonly by: "entry"; readonly entry: ProjectionEntryId }
  | { readonly by: "retained"; readonly because: string };

export interface ProjectionEntry {
  readonly id: ProjectionEntryId;
  readonly kind: ProjectionEntryKind;
  /** Repo-relative, POSIX separators. An entry spanning siblings names its primary. */
  readonly path: string;
  readonly scopes: readonly ProjectionScope[];
  /** `skipped` when an input this entry needs was not supplied. */
  write(input: ProjectionInput): Promise<ProjectionWriteState>;
  /**
   * Whether a failed write is reported without failing the operation that
   * triggered the projection. Only for an entry something else already covers:
   * the link is an optimisation over the per-runtime allow-lists, so a platform
   * that permits no link degrades rather than fails.
   */
  readonly degradable?: boolean;
  readonly removal: ProjectionEntryRemoval;
  /**
   * Whether the entry is on disk. Defaults to `path` existing, which is only
   * the truth for an `owned` entry: a `merged` entry shares its host path with
   * the human and must answer for its region alone.
   */
  present?(repoPath: string): Promise<boolean>;
}

export interface ProjectionEntryOutcome {
  id: ProjectionEntryId;
  path: string;
  kind: ProjectionEntryKind;
  state: ProjectionWriteState | ProjectionRemoveState | "failed";
  error?: Error;
  degradable?: boolean;
}

export interface ProjectionResult {
  root: string;
  scope: ProjectionScope;
  outcomes: ProjectionEntryOutcome[];
}

export interface ProjectionRemovalResult {
  root: string;
  outcomes: ProjectionEntryOutcome[];
}

export interface ProjectionEntryPresence {
  id: ProjectionEntryId;
  path: string;
  kind: ProjectionEntryKind;
  present: boolean;
}

/** What `describe` reports. No freshness verdict: that lives above this module. */
export interface ProjectionDescription {
  root: string;
  entries: ProjectionEntryPresence[];
  projection: ProjectionFile | null;
}

export function anyChanged(outcomes: ProjectionEntryOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.state === "written" || outcome.state === "removed");
}

/** A degradable entry's failure is reported in the outcomes and nowhere else. */
export function firstFailure(outcomes: ProjectionEntryOutcome[]): ProjectionEntryOutcome | null {
  return outcomes.find((outcome) => outcome.state === "failed" && !outcome.degradable) ?? null;
}
