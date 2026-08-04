import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { ConfigStore, validateHubConfig } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import type { FrameworkConfig, HubMember, HubMemberSource } from "./types";
import {
  installDeclaredPlugins,
  type PluginInstallDeps,
  type PluginInstallResult,
} from "../../tools/setup/dynamic-plugins/install";
import { hydrateDynamicPlugins } from "../../tools/setup/dynamic-plugins/hydrate";
import { findRepoLocalRegistryFile } from "./repo-local-registry";

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GitCommand = (cwd: string, args: string[]) => GitCommandResult;

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
}

export function defaultGitCommand(cwd: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

function isInsideDir(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function normalizeHubMemberId(value: string): string {
  const normalized = value
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`Cannot derive a hub member id from: ${value}`);
  return normalized;
}

export function validateHubMemberPath(hubPath: string, memberPath: string): string {
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
      allowedAgents: [],
      packageManagers: [],
      capabilities: [],
      hub: { companions: [] },
    };
    await configStore.save(config);
  }
  await globalConfigStore.register(hubPath);
  return hubPath;
}

export function discoverGitSource(
  sourcePath: string,
  git: GitCommand = defaultGitCommand,
): HubSource {
  const root = git(sourcePath, ["rev-parse", "--show-toplevel"]);
  if (root.status !== 0 || !root.stdout) return { kind: "local", path: path.resolve(sourcePath) };

  const remote = git(sourcePath, ["config", "--get", "remote.origin.url"]);
  if (remote.status !== 0 || !remote.stdout)
    return { kind: "local", path: path.resolve(sourcePath) };

  const branch = git(sourcePath, ["symbolic-ref", "--short", "HEAD"]);
  return {
    kind: "git",
    path: path.resolve(sourcePath),
    url: remote.stdout,
    ref: branch.status === 0 && branch.stdout ? branch.stdout : undefined,
  };
}

export function discoverHubSource(source: string, git: GitCommand = defaultGitCommand): HubSource {
  const trimmed = source.trim();
  if (/^(?:https?|ssh|git):\/\//i.test(trimmed) || trimmed.startsWith("git@")) {
    return { kind: "git", url: trimmed };
  }
  return discoverGitSource(path.resolve(trimmed), git);
}

function sourceForManifest(source: HubSource, fallbackPath: string): HubMemberSource {
  if (source.kind === "git") {
    return { kind: "git", url: source.url, ref: source.ref };
  }
  return { kind: "local", path: source.path ?? fallbackPath };
}

function gitOutputOrThrow(result: GitCommandResult, operation: string): string {
  if (result.status !== 0) {
    throw new Error(
      `${operation} failed: ${result.stderr || result.stdout || "unknown Git error"}`,
    );
  }
  return result.stdout;
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

async function currentCommit(memberPath: string, git: GitCommand): Promise<string> {
  return gitOutputOrThrow(git(memberPath, ["rev-parse", "HEAD"]), `Reading ${memberPath} commit`);
}

export async function materializeHubMember(
  hubPath: string,
  source: HubSource,
  options: { id?: string; memberPath?: string; git?: GitCommand } = {},
): Promise<HubMember> {
  const git = options.git ?? defaultGitCommand;
  const sourceName = source.url ?? source.path ?? "companion";
  const id = normalizeHubMemberId(options.id ?? path.basename(sourceName));
  const relativePath = options.memberPath ?? memberPathForId(id);
  const destination = validateHubMemberPath(hubPath, relativePath);
  const target = await fs.stat(destination).catch(() => null);
  if (target) throw new Error(`Hub member destination already exists: ${relativePath}`);

  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    if (source.kind === "git") {
      const args = ["clone"];
      if (source.ref) args.push("--branch", source.ref);
      args.push(source.url!, destination);
      gitOutputOrThrow(git(hubPath, args), `Cloning ${source.url}`);
    } else {
      await copyWithoutGit(source.path!, destination);
    }

    await assertMaterializedCompanion(destination);
    const member: HubMember = {
      id,
      path: relativePath,
      source: sourceForManifest(source, source.path ?? relativePath),
    };
    if (source.kind === "git") member.materializedCommit = await currentCommit(destination, git);
    return member;
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function addHubMember(
  hubPath: string,
  source: HubSource,
  options: { id?: string; memberPath?: string; git?: GitCommand } = {},
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

function syncTarget(memberPath: string, git: GitCommand): string | null {
  const upstream = git(memberPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream.status !== 0 || !upstream.stdout) return null;
  return upstream.stdout;
}

export async function syncHubMember(
  hubPath: string,
  member: HubMember,
  git: GitCommand = defaultGitCommand,
): Promise<HubSyncResult> {
  const memberPath = path.resolve(hubPath, member.path);
  if (member.source.kind === "local") {
    return { id: member.id, status: "local-only", message: "local-only child has no Git source" };
  }

  const dirty = git(memberPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty.status !== 0) {
    return {
      id: member.id,
      status: "failed",
      message: dirty.stderr || "unable to inspect Git state",
    };
  }
  if (dirty.stdout) {
    return { id: member.id, status: "dirty", message: "local changes must be resolved first" };
  }

  const fetch = git(memberPath, ["fetch", "origin"]);
  if (fetch.status !== 0) {
    return { id: member.id, status: "failed", message: fetch.stderr || "fetch failed" };
  }
  const target = syncTarget(memberPath, git);
  if (!target) {
    return { id: member.id, status: "failed", message: "no tracked upstream branch" };
  }
  const counts = git(memberPath, ["rev-list", "--left-right", "--count", `HEAD...${target}`]);
  if (counts.status !== 0) {
    return {
      id: member.id,
      status: "failed",
      message: counts.stderr || "unable to compare branches",
    };
  }
  const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
  if (ahead > 0 && behind > 0) {
    return {
      id: member.id,
      status: "divergent",
      message: "local and remote branches have diverged",
    };
  }
  if (behind === 0) {
    const commit = await currentCommit(memberPath, git);
    return {
      id: member.id,
      status: "up-to-date",
      message: "already up to date",
      materializedCommit: commit,
    };
  }

  const readTree = git(memberPath, ["read-tree", "-u", "-m", target]);
  if (readTree.status !== 0) {
    return {
      id: member.id,
      status: "failed",
      message: readTree.stderr || "fast-forward worktree update failed",
    };
  }
  const branch = git(memberPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.status !== 0 || !branch.stdout) {
    return { id: member.id, status: "failed", message: "cannot advance a detached HEAD" };
  }
  const updateRef = git(memberPath, ["update-ref", `refs/heads/${branch.stdout}`, target, "HEAD"]);
  if (updateRef.status !== 0) {
    return {
      id: member.id,
      status: "failed",
      message: updateRef.stderr || "fast-forward ref update failed",
    };
  }
  const commit = await currentCommit(memberPath, git);
  return {
    id: member.id,
    status: "updated",
    message: `fast-forwarded to ${commit}`,
    materializedCommit: commit,
  };
}

export async function syncHub(
  hubPath: string,
  git: GitCommand = defaultGitCommand,
): Promise<HubSyncResult[]> {
  const { config, store } = await assertHubRoot(hubPath);
  const results: HubSyncResult[] = [];
  for (const member of config.hub!.companions) {
    const result = await syncHubMember(hubPath, member, git);
    results.push(result);
    if (result.materializedCommit && result.status === "updated") {
      member.materializedCommit = result.materializedCommit;
    }
  }
  if (results.some((result) => result.status === "updated")) await store.save(config);
  return results;
}

export async function updateHubPlugins(
  hubPath: string,
  deps: HubPluginSyncDeps = {},
): Promise<PluginInstallResult[]> {
  const { config } = await assertHubRoot(hubPath);
  const declarations = config.plugins ?? [];
  if (declarations.length === 0) return [];

  const resolvedHubPath = path.resolve(hubPath);
  const results = await installDeclaredPlugins(resolvedHubPath, declarations, deps.installDeps);
  await (deps.hydrate ?? hydrateDynamicPlugins)({ companionPath: resolvedHubPath });
  return results;
}
