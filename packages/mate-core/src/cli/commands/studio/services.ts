import type { UsageRequest } from "../../../lib/usage/cache";
import type { UsageResponse } from "../../../lib/usage/types";
import type { StudioSpecGraph } from "./graph";
import type { StoredReport } from "./reports";
import type { StudioServiceSummary } from "./service-host";
import type { SkillAgent, SkillPreview } from "./skill-files";
import type { StudioModePolicy } from "./selection";
import type { VaultConflict, VaultSaved } from "./vault";
import type { StudioPage } from "./views/model";
import type { MdNode } from "./views/vault/markdown-tree";
import type { VaultEntry, VaultView, VaultViewRequest } from "./views/vault/view";

/**
 * What Studio's application may ask of the server it runs in. Core creates one
 * instance per server and hands it to every application request as context, so
 * Studio never constructs a service, reads a companion or starts a process itself.
 */
export interface StudioServices {
  /** Whether saves and Workset changes are enabled (`--writable`). */
  readonly writable: boolean;
  /** The plugin services this Studio mounted, with their views. */
  services(): StudioServiceSummary[];
  /**
   * Whether removing the companion only unregisters it: with a service's companion source,
   * Studio deletes only folders inside that source's folder.
   */
  keepsFolder(companionPath: string): boolean;
  /** Whether a mounted service adds companions by Git URL (its `companions` source). */
  addsCompanions(): boolean;
  /** The startup profile's Studio modes; every page selection is resolved through it. */
  readonly modePolicy: StudioModePolicy;
  /** Everything one view is derived from, for the address that asked for it. */
  page(url: URL): Promise<StudioPage>;
  /**
   * A plugin service's route (`/api/plugins/<id>/…`), called from a server function. The
   * caller's own guard stands for origin and token; the route's `writable` refusal applies.
   */
  callService(request: Request): Promise<Response>;
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
  /**
   * Adds a companion to Studio's registry, by Git URL (a service's companion source fetches it)
   * or by the absolute path of a folder Studio can read (registered in place). Needs `writable`
   * and a service's companion source.
   * A refusal is an answer, not an error; `tokenKey` names the Git token that would unlock a
   * private URL.
   */
  addCompanion(input: CompanionAddInput): Promise<CompanionAddResult>;
}

export type CompanionAddInput = { kind: "url"; url: string } | { kind: "path"; path: string };

export type CompanionAddResult =
  | { ok: true; digest: string; existing: boolean }
  | { ok: false; reason: string; tokenKey?: string };

/** The request context Studio's application receives from core on every request. */
export interface StudioRequestContext {
  studio: StudioServices;
}
