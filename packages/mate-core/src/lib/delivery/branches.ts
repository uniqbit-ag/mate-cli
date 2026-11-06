import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readCompanionConfig } from "../orchestrator/config-store";
import type { CapabilityConfig, TicketFormat } from "../orchestrator/types";
import { parseBranchTemplate, type BranchTemplateSetting } from "./branch-template";
import { listRefsWith } from "./resolve-branch";

export type { TicketFormat };

const execFileAsync = promisify(execFile);

export type ProtectionReason = "default" | "pattern";

export interface BranchProtection {
  protected: boolean;
  reason: ProtectionReason | null;
}

export interface ProtectionOptions {
  defaultBranch: string;
  /** Configured glob patterns; `*` stays within one path segment, `**` crosses segments. */
  patterns: readonly string[];
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** A branch is protected when it is the default branch or matches a pattern. */
export function classifyBranch(branch: string, options: ProtectionOptions): BranchProtection {
  if (branch === options.defaultBranch) return { protected: true, reason: "default" };
  if (options.patterns.some((pattern) => globToRegExp(pattern).test(branch))) {
    return { protected: true, reason: "pattern" };
  }
  return { protected: false, reason: null };
}

/** Protected-branch patterns from the companion's openspec capability config. */
export function configuredProtectedPatterns(capabilities: readonly CapabilityConfig[]): string[] {
  const openspec = capabilities.find((capability) => capability.name === "openspec");
  const patterns = openspec?.protectedBranches;
  return Array.isArray(patterns)
    ? patterns.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
}

export interface TicketSetting {
  format: TicketFormat;
  /** Set for a value Mate does not know, which counts as `none`. */
  diagnostic: string | null;
}

/** The openspec capability's `ticket` setting; absent or unknown means `none`. */
export function configuredTicketFormat(capabilities: readonly CapabilityConfig[]): TicketSetting {
  const value = capabilities.find((capability) => capability.name === "openspec")?.ticket;
  if (value === undefined || value === "none") return { format: "none", diagnostic: null };
  if (value === "jira") return { format: "jira", diagnostic: null };
  return {
    format: "none",
    diagnostic: `Unknown ticket setting ${JSON.stringify(value)} on the openspec capability; expected none or jira, so tickets are off.`,
  };
}

/** Why `--ticket` is refused while the companion's tickets are off. */
export const TICKETS_OFF =
  "tickets are off for this companion; set `ticket: jira` on the openspec capability (mate setup --ticket jira) to use one.";

/** The ticket setting in a companion's `framework.yaml`, as `mate artifact link` reads it. */
export async function companionTicketFormat(companionPath: string): Promise<TicketFormat> {
  const config = await readCompanionConfig(companionPath);
  return configuredTicketFormat(config.capabilities ?? []).format;
}

/** The openspec capability's `branchTemplate`; absent or invalid means the default. */
export function configuredBranchTemplate(
  capabilities: readonly CapabilityConfig[],
): BranchTemplateSetting {
  const openspec = capabilities.find((capability) => capability.name === "openspec");
  return parseBranchTemplate(openspec?.branchTemplate);
}

/** The Delivery Branch template in a companion's `framework.yaml`, with its diagnostic. */
export async function companionBranchTemplate(
  companionPath: string,
): Promise<BranchTemplateSetting> {
  const config = await readCompanionConfig(companionPath);
  return configuredBranchTemplate(config.capabilities ?? []);
}

/** Read-only local Git queries against a Working Repository. Nothing here touches the network. */
export interface WorkingRepoGit {
  /** Checked-out branch, or null in a detached HEAD. */
  currentBranch(): Promise<string | null>;
  /** `origin/HEAD`, then an existing `origin/main` or `origin/master`, then `init.defaultBranch`, then `main`. */
  defaultBranch(): Promise<string>;
  /** The `origin` remote URL, or null without one. */
  remoteUrl(): Promise<string | null>;
  /** One-line summaries of commits on HEAD that no remote-tracking branch contains. */
  unpushedCommits(): Promise<string[]>;
  /** True when the branch exists locally or as `origin/<branch>`. */
  branchExists(branch: string): Promise<boolean>;
  /** True when the ref (`refs/heads/<b>`, `refs/remotes/origin/<b>`) resolves. */
  hasRef(ref: string): Promise<boolean>;
  /** Full names of the refs under the given prefixes; empty when Git fails. */
  listRefs?(prefixes: string[]): Promise<string[]>;
}

export function workingRepoGit(repoPath: string): WorkingRepoGit {
  const run = async (...args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
      return stdout.trim();
    } catch {
      return null;
    }
  };

  const remoteTip = async (branch: string): Promise<string | null> =>
    (await run("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) || null;
  const defaultBranch = async (): Promise<string> => {
    const remoteHead = await run("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
    if (remoteHead) return remoteHead.replace(/^origin\//, "");
    for (const candidate of ["main", "master"]) {
      // oxlint-disable-next-line no-await-in-loop -- the steps are a decision chain
      if (await remoteTip(candidate)) return candidate;
    }
    return (await run("config", "--get", "init.defaultBranch")) || "main";
  };

  const hasRef = async (ref: string): Promise<boolean> =>
    (await run("rev-parse", "--verify", "--quiet", ref)) !== null;

  const currentBranch = async (): Promise<string | null> =>
    (await run("symbolic-ref", "--quiet", "--short", "HEAD")) || null;

  return {
    currentBranch,
    defaultBranch,
    async remoteUrl() {
      return (await run("remote", "get-url", "origin")) || null;
    },
    async unpushedCommits() {
      const log = await run("log", "--oneline", "HEAD", "--not", "--remotes");
      return log ? log.split("\n").filter(Boolean) : [];
    },
    async branchExists(branch: string) {
      return (
        (await hasRef(`refs/heads/${branch}`)) || (await hasRef(`refs/remotes/origin/${branch}`))
      );
    },
    hasRef,
    listRefs: listRefsWith((args) => run(...args)),
  };
}
