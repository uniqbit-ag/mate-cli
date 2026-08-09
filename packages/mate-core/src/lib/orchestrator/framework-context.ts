import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { parse } from "yaml";
import { CompanionResolver } from "./companion-resolver";
import { companionRootedStore } from "./companion-store";
import { readCompanionRegistry } from "./companion-registry-reader";
import { ConfigStore } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import { findRepoLocalLinkedRepository } from "./repo-local-registry";
import {
  AmbiguousCompanionError,
  ConfigError,
  type FrameworkConfig,
  type HubConfig,
  type LinkedRepository,
  RepositoryNotFoundError,
  WorkingRepoRequiredError,
} from "./types";
import { WorkingRepoStore } from "./working-repo-store";

export interface FrameworkContext {
  configStore: ConfigStore;
  workingRepoStore: WorkingRepoStore;
  companionPath: string;
  repository?: LinkedRepository;
  contextKind: "env" | "working-repo" | "companion-root" | "hub";
  hub?: HubConfig;
}

export interface LaunchContext extends FrameworkContext {
  repositoryId: string;
}

function repositoryFromEnvironment(): LinkedRepository | undefined {
  const repositoryPath = process.env.MATE_REPO_PATH;
  if (!repositoryPath) return undefined;

  return {
    id: process.env.MATE_REPO_ID ?? path.basename(path.resolve(repositoryPath)),
    path: path.resolve(repositoryPath),
  };
}

// Builds a FrameworkContext from a known companion path — wires up the config
// store, working repo store, and companion path. Used by all three resolvers.
function makeContext(
  companionPath: string,
  contextKind: FrameworkContext["contextKind"],
  repository?: LinkedRepository,
  hub?: HubConfig,
): FrameworkContext {
  const configDir = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config");
  return {
    configStore: new ConfigStore(path.join(configDir, "framework.yaml")),
    workingRepoStore: new WorkingRepoStore(path.join(configDir, "registry.yaml")),
    companionPath,
    repository,
    contextKind,
    hub,
  };
}

function isStrictChildPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative !== "" && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function validateHubMember(
  resolvedRoot: string,
  realRoot: string,
  member: HubConfig["companions"][number],
): Promise<ConfigError | null> {
  const memberPath = path.resolve(resolvedRoot, member.path);
  if (!isStrictChildPath(resolvedRoot, memberPath)) {
    return new ConfigError(
      `Hub member "${member.id}" path resolves outside the hub root: ${member.path}`,
    );
  }

  const stats = await fs.stat(memberPath).catch(() => null);
  if (!stats?.isDirectory()) {
    return new ConfigError(`Hub member "${member.id}" directory is missing: ${memberPath}`);
  }

  const realMemberPath = await fs.realpath(memberPath).catch(() => memberPath);
  if (!isStrictChildPath(realRoot, realMemberPath)) {
    return new ConfigError(
      `Hub member "${member.id}" path resolves outside the hub root: ${member.path}`,
    );
  }

  const childConfigPath = path.join(memberPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  let childConfig: Partial<FrameworkConfig> | null;
  try {
    childConfig = parse(
      await fs.readFile(childConfigPath, "utf8"),
    ) as Partial<FrameworkConfig> | null;
  } catch {
    return new ConfigError(
      `Hub member "${member.id}" must contain a framework.yaml declaring type "companion".`,
    );
  }

  if (childConfig?.type !== "companion") {
    return new ConfigError(
      `Hub member "${member.id}" must declare type "companion" in ${childConfigPath}.`,
    );
  }

  return null;
}

async function validateHubMembers(hubRoot: string, hub: HubConfig): Promise<void> {
  const resolvedRoot = path.resolve(hubRoot);
  const realRoot = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);
  const errors = await Promise.all(
    hub.companions.map((member) => validateHubMember(resolvedRoot, realRoot, member)),
  );
  const firstError = errors.find((error): error is ConfigError => error !== null);
  if (firstError) throw firstError;
}

async function withResolvedHub(context: FrameworkContext): Promise<FrameworkContext> {
  let rawConfig: Partial<FrameworkConfig> | null;
  try {
    rawConfig = parse(
      await fs.readFile(context.configStore.configPath, "utf8"),
    ) as Partial<FrameworkConfig> | null;
  } catch {
    return context;
  }

  if (rawConfig?.type !== "hub") return context;

  const config = await context.configStore.load();
  if (!config.hub) {
    throw new ConfigError('A "hub" framework requires a hub.companions array.');
  }
  await validateHubMembers(context.companionPath, config.hub);
  return { ...context, contextKind: "hub", hub: config.hub };
}

// Resolves the companion framework context without a repositoryId. Used by commands
// that only need companion config (e.g. `mate doctor`, `mate config`, `mate report`). Resolution order:
// 1. MATE_ARTIFACT_PATH env var (agent-launched sessions)
// 2. CompanionResolver — cwd inside a linked working repo
// 3. Local .mate/config/framework.yaml in cwd (cwd is the companion itself)
export async function resolveFrameworkContext(
  cwd: string,
  globalConfigStore = new GlobalConfigStore(),
): Promise<FrameworkContext> {
  const envCompanionPath = process.env.MATE_ARTIFACT_PATH;
  if (envCompanionPath) {
    const repository = repositoryFromEnvironment() ?? (await findRepoLocalLinkedRepository(cwd));
    return withResolvedHub(
      makeContext(path.resolve(envCompanionPath), "env", repository ?? undefined),
    );
  }

  const match = await new CompanionResolver(globalConfigStore).resolve(cwd);
  if (match) {
    return withResolvedHub(
      makeContext(
        match.companionPath,
        "working-repo",
        (await findRepoLocalLinkedRepository(cwd)) ?? undefined,
      ),
    );
  }

  const localDir = path.join(cwd, `.${FRAMEWORK_NAME}`);

  const localConfigPath = path.join(localDir, "config", "framework.yaml");
  try {
    await fs.access(localConfigPath);
  } catch {
    // no local config
    throw new RepositoryNotFoundError(`No companion found for current directory: ${cwd}`);
  }
  return withResolvedHub(makeContext(cwd, "companion-root"));
}

// Resolves context for agent-launch commands. Returns a LaunchContext with repositoryId.
// Resolution order:
// 1. MATE_ARTIFACT_PATH + MATE_REPO_ID env vars (agent-launched sessions)
// 2. CompanionResolver — cwd inside a linked working repo
// Does NOT fall back to local config — launching from the companion root is invalid.
// Use resolveForCapability if the caller may run from the companion directory.
export async function resolveForLaunch(
  cwd: string,
  globalConfigStore = new GlobalConfigStore(),
): Promise<LaunchContext> {
  const envCompanionPath = process.env.MATE_ARTIFACT_PATH;
  if (envCompanionPath) {
    const repository = repositoryFromEnvironment() ?? (await findRepoLocalLinkedRepository(cwd));
    const repositoryId = process.env.MATE_REPO_ID ?? repository?.id ?? "";
    const context = await withResolvedHub(
      makeContext(path.resolve(envCompanionPath), "env", repository ?? undefined),
    );
    return {
      ...context,
      repositoryId,
    };
  }

  const resolution = await new CompanionResolver(globalConfigStore).resolveWithDiagnostics(cwd);
  if (resolution.ambiguousMatches.length > 1) {
    throw new AmbiguousCompanionError(
      resolution.ambiguousMatches.map((match) => match.companionPath),
    );
  }

  if (resolution.match) {
    const repository = (await findRepoLocalLinkedRepository(cwd)) ?? undefined;
    if (repository) {
      await backfillCompanionRegistration(resolution.match.companionPath, repository);
    }
    const context = await withResolvedHub(
      makeContext(resolution.match.companionPath, "working-repo", repository),
    );
    return {
      ...context,
      repositoryId: resolution.match.repositoryId,
    };
  }

  throw new WorkingRepoRequiredError();
}

/**
 * Self-heals repos linked before the companion-side registry write existed
 * (or whose companion registry was reset): backfills the companion-side
 * entry from the already-trusted repo-local pointer on every launch
 * resolution. Best-effort — never blocks a launch.
 */
async function backfillCompanionRegistration(
  companionPath: string,
  repository: LinkedRepository,
): Promise<void> {
  try {
    const { repos } = await readCompanionRegistry(companionPath).catch(() => ({ repos: [] }));
    const existing = repos.find((repo) => repo.id === repository.id);
    if (existing?.path === repository.path) return;

    await companionRootedStore(companionPath).registerRepository(repository);
  } catch (error) {
    console.error(
      `${FRAMEWORK_NAME}: warning: failed to backfill companion registry for ${repository.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// Resolves context for `mate cap` commands. Unlike resolveForLaunch, this allows
// running from the companion directory itself — cap commands manage companion state
// and don't need a working-repo cwd. resolveForLaunch intentionally lacks this
// fallback because launching an agent from the companion root is not a valid scenario.
export async function resolveForCapability(
  cwd: string,
  globalConfigStore = new GlobalConfigStore(),
): Promise<LaunchContext> {
  const envCompanionPath = process.env.MATE_ARTIFACT_PATH;
  if (envCompanionPath) {
    const repository = repositoryFromEnvironment() ?? (await findRepoLocalLinkedRepository(cwd));
    const ctx = await withResolvedHub(
      makeContext(path.resolve(envCompanionPath), "env", repository ?? undefined),
    );
    const repositoryId = process.env.MATE_REPO_ID;
    if (repositoryId) {
      return { ...ctx, repositoryId };
    }

    if (repository) {
      return { ...ctx, repositoryId: repository.id };
    }

    return { ...ctx, repositoryId: "" };
  }

  const match = await new CompanionResolver(globalConfigStore).resolve(cwd);
  if (match) {
    const context = await withResolvedHub(
      makeContext(
        match.companionPath,
        "working-repo",
        (await findRepoLocalLinkedRepository(cwd)) ?? undefined,
      ),
    );
    return {
      ...context,
      repositoryId: match.repositoryId,
    };
  }

  // Fallback: cwd is the companion directory — resolve from its local config.
  // This is specific to mate cap; resolveForLaunch does NOT get this fallback.
  const localDir = path.join(cwd, `.${FRAMEWORK_NAME}`);

  const localConfigPath = path.join(localDir, "config", "framework.yaml");
  try {
    await fs.access(localConfigPath);
  } catch {
    // no local config
    throw new WorkingRepoRequiredError("cap");
  }
  const context = await withResolvedHub(makeContext(cwd, "companion-root"));
  return { ...context, repositoryId: process.env.MATE_REPO_ID ?? "" };
}
