import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { canonicalPath } from "../../runtime/physical-path";
import { parse } from "yaml";
import { CompanionRegistryStore } from "./companion-registry-store";
import { ConfigStore } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import {
  backfillCompanionRegistration,
  CompanionResolver,
  findRepoLocalLinkedRepository,
} from "./repository-link";
import { projectWorkingRepositoryBestEffort } from "./working-repo-projection";
import {
  AmbiguousCompanionError,
  ConfigError,
  type FrameworkConfig,
  type HubConfig,
  type LinkedRepository,
  type LaunchScope,
  RepositoryNotFoundError,
  WorkingRepoRequiredError,
} from "./types";

export interface FrameworkContext {
  configStore: ConfigStore;
  workingRepoStore: CompanionRegistryStore;
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
// Canonicalised first so a `link/..` spelling loads where it leads, not a decoy.
function makeContext(
  configuredPath: string,
  contextKind: FrameworkContext["contextKind"],
  repository?: LinkedRepository,
  hub?: HubConfig,
): FrameworkContext {
  const companionPath = path.resolve(canonicalPath(configuredPath));
  const configDir = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config");
  return {
    configStore: new ConfigStore(path.join(configDir, "framework.yaml")),
    workingRepoStore: new CompanionRegistryStore(path.join(configDir, "registry.yaml")),
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
    return withResolvedHub(makeContext(envCompanionPath, "env", repository ?? undefined));
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
// A companion-scoped launch may also resolve the local companion config from cwd.
export async function resolveForLaunch(
  cwd: string,
  globalConfigStore = new GlobalConfigStore(),
  scope: LaunchScope = "working-repo",
): Promise<LaunchContext> {
  const envCompanionPath = process.env.MATE_ARTIFACT_PATH;
  if (envCompanionPath) {
    if (scope === "companion") {
      const context = await withResolvedHub(makeContext(envCompanionPath, "env"));
      return { ...context, repositoryId: "" };
    }
    const repository = repositoryFromEnvironment() ?? (await findRepoLocalLinkedRepository(cwd));
    const repositoryId = process.env.MATE_REPO_ID ?? repository?.id ?? "";
    const context = await withResolvedHub(
      makeContext(envCompanionPath, "env", repository ?? undefined),
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
    if (scope === "companion") {
      const context = await withResolvedHub(
        makeContext(resolution.match.companionPath, "working-repo"),
      );
      return { ...context, repositoryId: "" };
    }
    if (repository) {
      await backfillCompanionRegistration(resolution.match.companionPath, repository);
      await projectWorkingRepositoryBestEffort(resolution.match.companionPath, repository);
    }
    const context = await withResolvedHub(
      makeContext(resolution.match.companionPath, "working-repo", repository),
    );
    return {
      ...context,
      repositoryId: resolution.match.repositoryId,
    };
  }

  if (scope === "companion") {
    const localConfigPath = path.join(cwd, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    let localConfig: Partial<FrameworkConfig> | null;
    try {
      localConfig = parse(await fs.readFile(localConfigPath, "utf8")) as Partial<FrameworkConfig>;
    } catch {
      localConfig = null;
    }
    if (localConfig?.type !== "companion") {
      throw new RepositoryNotFoundError(`No companion found for current directory: ${cwd}`);
    }
    const context = await withResolvedHub(makeContext(cwd, "companion-root"));
    return { ...context, repositoryId: "" };
  }

  throw new WorkingRepoRequiredError();
}

// Resolves context for `mate cap` commands. Unlike resolveForLaunch, this allows
// running from the companion directory itself — cap commands manage companion state
// and don't need a working-repo cwd. resolveForLaunch intentionally lacks this
// fallback because its implicit launch scope still requires a Working Repository.
export async function resolveForCapability(
  cwd: string,
  globalConfigStore = new GlobalConfigStore(),
): Promise<LaunchContext> {
  const envCompanionPath = process.env.MATE_ARTIFACT_PATH;
  if (envCompanionPath) {
    const repository = repositoryFromEnvironment() ?? (await findRepoLocalLinkedRepository(cwd));
    const ctx = await withResolvedHub(
      makeContext(envCompanionPath, "env", repository ?? undefined),
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

  /**
   * `resolveWithDiagnostics` only to learn whether the match is ambiguous;
   * `resolve()` is this same call with `logFailures`, so the returned match is
   * unchanged. Unlike `resolveForLaunch` this does not refuse on ambiguity —
   * it only declines to make a guessed companion durable.
   */
  const resolution = await new CompanionResolver(globalConfigStore).resolveWithDiagnostics(cwd, {
    logFailures: true,
  });
  const match = resolution.match;
  if (match) {
    const repository = (await findRepoLocalLinkedRepository(cwd)) ?? undefined;
    if (repository && resolution.ambiguousMatches.length <= 1) {
      await projectWorkingRepositoryBestEffort(match.companionPath, repository);
    }
    const context = await withResolvedHub(
      makeContext(match.companionPath, "working-repo", repository),
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
