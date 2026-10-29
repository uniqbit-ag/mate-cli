import path from "node:path";

import type { WorkingRepoGit } from "./branches";
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
  /**
   * Host of a repository other than the Working Repository, from a linked checkout's
   * `origin` remote, else the Working Repository's host; null when neither is known.
   */
  hostOf?: (repository: string) => Promise<string | null>;
}

/** `dir` relative to the companion, with forward slashes. */
export function companionRelative(environment: DeliveryEnvironment, dir: string): string {
  return path.relative(environment.companionPath, dir).split(path.sep).join("/");
}
