import fs from "node:fs/promises";
import path from "node:path";

import { frameworkConfig } from "../../framework";
import { CompanionResolver } from "./companion-resolver";
import { ConfigStore } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import { migrateConfigDir } from "./migration";
import { findRepoLocalLinkedRepository } from "./repo-local-registry";
import {
  AmbiguousCompanionError,
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
  contextKind: "env" | "working-repo" | "companion-root";
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
    profile: process.env.MATE_REPO_PROFILE ?? "default",
  };
}

// Builds a FrameworkContext from a known companion path — wires up the config
// store, working repo store, and companion path. Used by all three resolvers.
function makeContext(
  companionPath: string,
  contextKind: FrameworkContext["contextKind"],
  repository?: LinkedRepository,
): FrameworkContext {
  const configDir = path.join(companionPath, `.${frameworkConfig.name}`, "config");
  return {
    configStore: new ConfigStore(path.join(configDir, "framework.yaml")),
    workingRepoStore: new WorkingRepoStore(path.join(configDir, "registry.yaml")),
    companionPath,
    repository,
    contextKind,
  };
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
    return makeContext(path.resolve(envCompanionPath), "env", repository ?? undefined);
  }

  const match = await new CompanionResolver(globalConfigStore).resolve(cwd);
  if (match) {
    return makeContext(
      match.companionPath,
      "working-repo",
      (await findRepoLocalLinkedRepository(cwd)) ?? undefined,
    );
  }

  const localDir = path.join(cwd, `.${frameworkConfig.name}`);
  const localLegacyDirs = frameworkConfig.legacyNames.map((n) => path.join(cwd, `.${n}`));
  await migrateConfigDir(localDir, localLegacyDirs);

  const localConfigPath = path.join(localDir, "config", "framework.yaml");
  try {
    await fs.access(localConfigPath);
    return makeContext(cwd, "companion-root");
  } catch {
    // no local config
  }

  throw new RepositoryNotFoundError(`No companion found for current directory: ${cwd}`);
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
    return {
      ...makeContext(path.resolve(envCompanionPath), "env", repository ?? undefined),
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
    return {
      ...makeContext(resolution.match.companionPath, "working-repo", repository),
      repositoryId: resolution.match.repositoryId,
    };
  }

  throw new WorkingRepoRequiredError();
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
    const ctx = makeContext(path.resolve(envCompanionPath), "env", repository ?? undefined);
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
    return {
      ...makeContext(
        match.companionPath,
        "working-repo",
        (await findRepoLocalLinkedRepository(cwd)) ?? undefined,
      ),
      repositoryId: match.repositoryId,
    };
  }

  // Fallback: cwd is the companion directory — resolve from its local config.
  // This is specific to mate cap; resolveForLaunch does NOT get this fallback.
  const localDir = path.join(cwd, `.${frameworkConfig.name}`);
  const localLegacyDirs = frameworkConfig.legacyNames.map((n) => path.join(cwd, `.${n}`));
  await migrateConfigDir(localDir, localLegacyDirs);

  const localConfigPath = path.join(localDir, "config", "framework.yaml");
  try {
    await fs.access(localConfigPath);
    return { ...makeContext(cwd, "companion-root"), repositoryId: process.env.MATE_REPO_ID ?? "" };
  } catch {
    // no local config
  }

  throw new WorkingRepoRequiredError("cap");
}
