import type { StudioInventory, StudioInventoryCompanion } from "../inventory";
import type { StudioCompanionPayload } from "../payload";
import type { StudioSelection } from "../selection";
import type { TerminalAgent } from "../terminal";
import type { VaultFile, VaultTreeNode } from "../vault";

/**
 * Everything one rendered document is derived from. `payload` and `error` are
 * mutually exclusive and both are absent until a companion is named, and
 * `collectedAt` is the moment the served snapshot was collected — not the
 * moment of this request.
 */
export interface StudioPage {
  inventory: StudioInventory;
  selection: StudioSelection;
  companion: StudioInventoryCompanion | null;
  payload: StudioCompanionPayload | null;
  error: { companionPath: string; reason: string } | null;
  collectedAt: number | null;
  writable: boolean;
  vault: StudioVaultPage | null;
  /** `null` unless the terminal is enabled. */
  terminal: StudioTerminalPage | null;
}

export interface StudioTerminalPage {
  /** The launch companion was pinned at start and ignores the page selection. */
  pinned: boolean;
  target: { path: string; digest: string } | null;
  agents: TerminalAgent[];
}

export interface StudioVaultPage {
  tree: VaultTreeNode[];
  open: VaultFile | null;
  refusal: string | null;
  incoming: VaultFile | null;
  overwritten: VaultFile | null;
  watching: boolean;
  warning: string | null;
}

/**
 * Local wall-clock time of a snapshot. Studio serves the browser that runs on
 * the same machine, so the server's local time is the reader's.
 */
export function formatCollectedAt(collectedAt: number): string {
  const at = new Date(collectedAt);
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function healthNote(companion: StudioInventoryCompanion): string {
  if (companion.health === "ready") return "";
  return companion.diagnostic ? `${companion.health} — ${companion.diagnostic}` : companion.health;
}
