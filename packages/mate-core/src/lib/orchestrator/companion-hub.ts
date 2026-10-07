import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { ConfigStore, validateHubConfig } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import type { FrameworkConfig, HubMember, HubMemberSource } from "./types";
import { listSetupProviderCompatibilities } from "./setup-compatibilities";
import {
  installDeclaredPlugins,
  type PluginInstallDeps,
  type PluginInstallResult,
} from "../../tools/setup/dynamic-plugins/install";
import { hydrateDynamicPlugins } from "../../tools/setup/dynamic-plugins/hydrate";
import { applySetupCompatibilities } from "../../tools/setup";
import { findRepoLocalRegistryFile } from "./repo-local-registry";
import { companionGit, describeGitFailure, type CompanionGit } from "../../runtime/companion-git";

export interface HubGitOptions {
  /** Environment Git runs with. */
  env?: Record<string, string | undefined>;
}

export interface HubSource {
  kind: "git" | "local";
  path?: string;
  url?: string;
  ref?: string;
}

export interface HubSyncResult {
  id: string;
  status: "updated" | "up-to-date" | "local-only" | "dirty" | "divergent" | "failed";
  message: string;
  materializedCommit?: string;
}

export interface HubPluginSyncDeps {
  installDeps?: PluginInstallDeps;
  hydrate?: (options: { companionPath: string }) => Promise<void>;
  setup?: (companionPath: string, config: FrameworkConfig, mode: "setup" | "sync") => Promise<void>;
}

/** Hub work is operator-driven, so it may prompt when a terminal is attached. */
function hubGit(cwd: string, options: HubGitOptions = {}): CompanionGit {
  return companionGit(cwd, { prompt: "if-terminal", env: options.env });
}

async function gitOutput(git: CompanionGit, args: string[]): Promise<string | null> {
  const result = await git.run(args);
  const stdout = result.stdout.trim();
  return result.status === 0 && stdout ? stdout : null;
}

function isInsideDir(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeHubMemberId(value: string): string {
  const normalized = value
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`Cannot derive a hub member id from: ${value}`);
  return normalized;
}

function validateHubMemberPath(hubPath: string, memberPath: string): string {
  if (!memberPath || path.isAbsolute(memberPath)) {
    throw new Error("Hub member path must be relative to the hub root.");
  }
  const resolved = path.resolve(hubPath, memberPath);
  if (!isInsideDir(hubPath, resolved)) {
    throw new Error(`Hub member path resolves outside the hub root: ${memberPath}`);
  }
  return resolved;
}

function frameworkConfigPath(root: string): string {
  return path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
}

function memberPathForId(id: string): string {
  return path.join("companions", id);
}

async function assertHubRoot(
  hubPath: string,
): Promise<{ config: FrameworkConfig; store: ConfigStore }> {
  const resolved = path.resolve(hubPath);
  const configStore = new ConfigStore(frameworkConfigPath(resolved));
  const config = await configStore.load();
  if (config.type !== "hub") {
    throw new Error(`Not a companion hub: ${resolved}`);
  }
  validateHubConfig(config);
  return { config, store: configStore };
}

export async function initializeCompanionHub(
  folder: string,
  globalConfigStore = new GlobalConfigStore(),
): Promise<string> {
  const hubPath = path.resolve(folder);
  const linkedRepo = await findRepoLocalRegistryFile(hubPath);
  if (linkedRepo) {
    throw new Error(
      `Cannot initialize a hub inside linked working repository: ${linkedRepo.repoRoot}`,
    );
  }
  await fs.mkdir(hubPath, { recursive: true });
  const configStore = new ConfigStore(frameworkConfigPath(hubPath));
  const existing = await fs.stat(configStore.configPath).catch(() => null);
  if (existing) {
    const current = await configStore.load();
    if (current.type !== "hub") {
      throw new Error(`Cannot initialize hub over an existing non-hub framework: ${hubPath}`);
    }
  } else {
    const config: FrameworkConfig = {
      type: "hub",
      allowedAgents: listSetupProviderCompatibilities().map((entry) => entry.agent),
      packageManagers: [],
      capabilities: [],
      hub: { companions: [] },
    };
    await configStore.save(config);
  }
  await globalConfigStore.register(hubPath);
  return hubPath;
}

export async function discoverGitSource(
  sourcePath: string,
  options: HubGitOptions = {},
): Promise<HubSource> {
  const git = companionGit(sourcePath, { prompt: "never", env: options.env });
  if (!(await gitOutput(git, ["rev-parse", "--show-toplevel"]))) {
    return { kind: "local", path: path.resolve(sourcePath) };
  }

  const remote = await gitOutput(git, ["config", "--get", "remote.origin.url"]);
  if (!remote) return { kind: "local", path: path.resolve(sourcePath) };

  const branch = await gitOutput(git, ["symbolic-ref", "--short", "HEAD"]);
  return {
    kind: "git",
    path: path.resolve(sourcePath),
    url: remote,
    ref: branch ?? undefined,
  };
}

export async function discoverHubSource(
  source: string,
  options: HubGitOptions = {},
): Promise<HubSource> {
  const trimmed = source.trim();
  if (/^(?:https?|ssh|git):\/\//i.test(trimmed) || trimmed.startsWith("git@")) {
    return { kind: "git", url: trimmed };
  }
  return discoverGitSource(path.resolve(trimmed), options);
}

function sourceForManifest(source: HubSource, fallbackPath: string): HubMemberSource {
  if (source.kind === "git") {
    return { kind: "git", url: source.url, ref: source.ref };
  }
  return { kind: "local", path: source.path ?? fallbackPath };
}

async function copyWithoutGit(sourcePath: string, destination: string): Promise<void> {
  await fs.cp(sourcePath, destination, {
    recursive: true,
    filter: (candidate) => path.basename(candidate) !== ".git",
  });
}

async function assertMaterializedCompanion(memberPath: string): Promise<void> {
  const configPath = frameworkConfigPath(memberPath);
  const raw = await fs.readFile(configPath, "utf8").catch(() => "");
  const config = parse(raw) as { type?: unknown } | null;
  if (config?.type !== "companion") {
    throw new Error(`Materialized child must declare type: companion: ${memberPath}`);
  }
}

async function currentCommit(memberPath: string, options: HubGitOptions): Promise<string> {
  const head = await hubGit(memberPath, options).run(["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    throw new Error(`Reading ${memberPath} commit failed: ${describeGitFailure(head)}`);
  }
  return head.stdout.trim();
}

export async function materializeHubMember(
  hubPath: string,
  source: HubSource,
  options: { id?: string; memberPath?: string } & HubGitOptions = {},
): Promise<HubMember> {
  const sourceName = source.url ?? source.path ?? "companion";
  const id = normalizeHubMemberId(options.id ?? path.basename(sourceName));
  const relativePath = options.memberPath ?? memberPathForId(id);
  const destination = validateHubMemberPath(hubPath, relativePath);
  const target = await fs.stat(destination).catch(() => null);
  if (target) throw new Error(`Hub member destination already exists: ${relativePath}`);

  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    if (source.kind === "git") {
      const clone = await hubGit(hubPath, options).clone(source.url!, destination, {
        branch: source.ref,
      });
      if (clone.status !== 0) {
        throw new Error(`Cloning ${source.url} failed: ${describeGitFailure(clone)}`);
      }
    } else {
      await copyWithoutGit(source.path!, destination);
    }

    await assertMaterializedCompanion(destination);
    const member: HubMember = {
      id,
      path: relativePath,
      source: sourceForManifest(source, source.path ?? relativePath),
    };
    if (source.kind === "git") {
      member.materializedCommit = await currentCommit(destination, options);
    }
    return member;
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function addHubMember(
  hubPath: string,
  source: HubSource,
  options: { id?: string; memberPath?: string } & HubGitOptions = {},
): Promise<HubMember> {
  const { config, store } = await assertHubRoot(hubPath);
  const member = await materializeHubMember(hubPath, source, options);
  if (config.hub!.companions.some((candidate) => candidate.id === member.id)) {
    await fs.rm(path.resolve(hubPath, member.path), { recursive: true, force: true });
    throw new Error(`Hub member id already exists: ${member.id}`);
  }
  config.hub!.companions.push(member);
  await store.save(config);
  return member;
}

async function syncHubMember(
  hubPath: string,
  member: HubMember,
  options: HubGitOptions,
): Promise<HubSyncResult> {
  const memberPath = path.resolve(hubPath, member.path);
  if (member.source.kind === "local") {
    return { id: member.id, status: "local-only", message: "local-only child has no Git source" };
  }
  const git = hubGit(memberPath, options);
  const failed = (message: string): HubSyncResult => ({ id: member.id, status: "failed", message });

  const dirty = await git.run(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty.status !== 0) return failed(dirty.stderr.trim() || "unable to inspect Git state");
  if (dirty.stdout.trim()) {
    return { id: member.id, status: "dirty", message: "local changes must be resolved first" };
  }

  const fetch = await git.fetch(["origin"]);
  if (fetch.status !== 0) return failed(fetch.stderr.trim() || "fetch failed");
  const target = await git.upstreamTarget();
  if (!target) return failed("no synchronization target resolves");
  const fork = await git.forkState(target.ref);
  if (!fork) return failed("unable to compare branches");
  if (fork.forked) {
    return {
      id: member.id,
      status: "divergent",
      message: "local and remote branches have diverged",
    };
  }
  if (fork.behind === 0) {
    return {
      id: member.id,
      status: "up-to-date",
      message: "already up to date",
      materializedCommit: await currentCommit(memberPath, options),
    };
  }

  const readTree = await git.run(["read-tree", "-u", "-m", target.ref]);
  if (readTree.status !== 0) {
    return failed(readTree.stderr.trim() || "fast-forward worktree update failed");
  }
  const branch = await gitOutput(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) return failed("cannot advance a detached HEAD");
  const updateRef = await git.run(["update-ref", `refs/heads/${branch}`, target.ref, "HEAD"]);
  if (updateRef.status !== 0) {
    return failed(updateRef.stderr.trim() || "fast-forward ref update failed");
  }
  const commit = await currentCommit(memberPath, options);
  return {
    id: member.id,
    status: "updated",
    message: `fast-forwarded to ${commit}`,
    materializedCommit: commit,
  };
}

export async function syncHub(
  hubPath: string,
  options: HubGitOptions = {},
): Promise<HubSyncResult[]> {
  const { config, store } = await assertHubRoot(hubPath);
  const results: HubSyncResult[] = [];
  for (const member of config.hub!.companions) {
    const result = await syncHubMember(hubPath, member, options);
    results.push(result);
    if (result.materializedCommit && result.status === "updated") {
      member.materializedCommit = result.materializedCommit;
    }
  }
  if (results.some((result) => result.status === "updated")) await store.save(config);
  return results;
}

/**
 * Hubs persisted before provider bootstrapping carry `allowedAgents: []`;
 * an empty list on a hub means "all built-in agents", not "none".
 */
export function backfillHubAllowedAgents(config: FrameworkConfig): boolean {
  if (config.type !== "hub" || config.allowedAgents.length > 0) return false;
  config.allowedAgents = listSetupProviderCompatibilities().map((entry) => entry.agent);
  return true;
}

export async function updateHubPlugins(
  hubPath: string,
  deps: HubPluginSyncDeps = {},
): Promise<PluginInstallResult[]> {
  const { config, store } = await assertHubRoot(hubPath);
  if (backfillHubAllowedAgents(config)) await store.save(config);
  const declarations = config.plugins ?? [];
  const resolvedHubPath = path.resolve(hubPath);
  const results =
    declarations.length > 0
      ? await installDeclaredPlugins(resolvedHubPath, declarations, deps.installDeps)
      : [];
  if (declarations.length > 0) {
    await (deps.hydrate ?? hydrateDynamicPlugins)({ companionPath: resolvedHubPath });
  }
  await (
    deps.setup ??
    ((companionPath, setupConfig, mode) =>
      applySetupCompatibilities(companionPath, setupConfig, mode, undefined, undefined, "hub"))
  )(resolvedHubPath, config, "sync");
  return results;
}
