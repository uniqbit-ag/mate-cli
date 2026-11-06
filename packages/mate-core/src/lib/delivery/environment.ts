import path from "node:path";

import type { BranchTemplateSetting } from "./branch-template";
import type { TicketSetting, WorkingRepoGit } from "./branches";
import type { ForgeRepo } from "./forge";

export interface WorkingRepoInfo {
  path: string;
  /** Full repository path from the `origin` remote (`acme/platform/api`), or null without one. */
  slug: string | null;
  forgeRepo: ForgeRepo | null;
  git: WorkingRepoGit;
}

/** The companion, the Working Repository with its remote identity, and protected-branch patterns. */
export interface DeliveryEnvironment {
  companionPath: string;
  workingRepo: WorkingRepoInfo | null;
  protectedPatterns: string[];
  /** The companion's ticket setting; absent means `none`. */
  ticket?: TicketSetting;
  /** The companion's Delivery Branch template; absent means the default. */
  branchTemplate?: BranchTemplateSetting;
  /**
   * Host of a repository other than the Working Repository, from a linked checkout's
   * `origin` remote, else the Working Repository's host; null when neither is known.
   */
  hostOf?: (repository: string) => Promise<string | null>;
  /** Path of a local checkout of the repository: the Working Repository or a linked one. */
  checkoutOf?: (repository: string) => Promise<string | null>;
  /** The companion's Git mode is `auto`: merge checks fetch before reading local refs. */
  gitAutoMode?: boolean;
}

/** `dir` relative to the companion, with forward slashes. */
export function companionRelative(environment: DeliveryEnvironment, dir: string): string {
  return path.relative(environment.companionPath, dir).split(path.sep).join("/");
}
