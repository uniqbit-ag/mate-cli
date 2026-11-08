import type { OutcomeAction } from "../../../lib/factory/outcomes/actions";
import type { UsageRequest } from "../../../lib/usage/cache";
import type { UsageResponse } from "../../../lib/usage/types";
import type { StudioSpecGraph } from "./graph";
import type { StoredReport } from "./reports";
import type { SkillAgent, SkillPreview } from "./skill-files";
import type { StudioModePolicy } from "./selection";
import type { VaultConflict, VaultSaved } from "./vault";
import type { StudioPage } from "./views/model";
import type { MdNode } from "./views/vault/markdown-tree";
import type { VaultEntry, VaultView, VaultViewRequest } from "./views/vault/view";

/** The fields of a submitted factory form; an absent field reads as an empty string. */
export type StudioFormField = (name: string) => string;

/**
 * What Studio's application may ask of the server it runs in. Core creates one
 * instance per server and hands it to every application request as context, so
 * Studio never constructs a service, reads a companion or starts a process itself.
 */
export interface StudioServices {
  /** Whether saves and Workset changes are enabled (`--writable`). */
  readonly writable: boolean;
  /** Whether the factory broker is reachable, so the Agents panel can be offered. */
  readonly factoryMode: boolean;
  /** The startup profile's Studio modes; every page selection is resolved through it. */
  readonly modePolicy: StudioModePolicy;
  /** Everything one view is derived from, for the address that asked for it. */
  page(url: URL): Promise<StudioPage>;
  /**
   * A board action on one Workset of a registered companion, named by its digest; needs
   * `writable`. Refused, changing nothing, when the Outcome does not accept it now.
   */
  worksetAction(
    companionDigest: string,
    id: string,
    action: OutcomeAction,
    field: StudioFormField,
  ): Promise<void>;
  /** The outcome input: Start runs it at once, Save for later keeps it unstarted; needs `writable`. */
  createOutcome(companionDigest: string, field: StudioFormField): Promise<void>;
  /** The vault page: the bounded tree and the open folder or file. */
  vault(companionDigest: string, request: VaultViewRequest): Promise<VaultView>;
  /** A folder's entries, when first expanded; `null` when the listed tree lacks it. */
  vaultChildren(
    companionDigest: string,
    dir: string,
  ): Promise<{ entries: VaultEntry[]; generation: number } | null>;
  /** Files matching a name filter over the whole listed tree, bounded. */
  vaultMatches(
    companionDigest: string,
    query: string,
  ): Promise<{ shown: VaultEntry[]; total: number; generation: number }>;
  /** Unsaved editor text rendered as the file at `path` would be; reads and writes nothing. */
  vaultPreview(companionDigest: string, path: string, content: string): Promise<MdNode[]>;
  /** Saves (or, without a token, creates) a markdown file; a stale token is a conflict, not an error. */
  vaultSave(
    companionDigest: string,
    path: string,
    content: string,
    token?: string,
  ): Promise<VaultSaved | VaultConflict>;
  /** The spec graph of the companion's canonical specs and archives; read-only, rebuilt when they change. */
  graph(companionDigest: string): Promise<StudioSpecGraph>;
  /** A registered companion's published reports, newest first; no paths or content. */
  reports(companionDigest: string): Promise<StoredReport[]>;
  /** Read-only, explicitly refreshed usage; never collected for unrelated views. */
  usage(companionDigest: string, request: UsageRequest): Promise<UsageResponse>;
  /** One installed skill's files and one of them rendered (SKILL.md by default); read-only. */
  skillPreview(
    companionDigest: string,
    agent: SkillAgent,
    name: string,
    file?: string,
  ): Promise<SkillPreview>;
  /**
   * Deletes a registered companion's folder and unregisters it, or only unregisters a stale
   * one whose folder is gone; not recoverable. Needs `writable`, and refuses the companion
   * Studio was started for.
   */
  deleteCompanion(companionDigest: string): Promise<{ deletedFolder: boolean }>;
}

/** The request context Studio's application receives from core on every request. */
export interface StudioRequestContext {
  studio: StudioServices;
}
