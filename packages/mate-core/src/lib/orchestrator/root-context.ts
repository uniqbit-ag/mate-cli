import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { CompanionResolver, type CompanionResolutionResult } from "./companion-resolver";
import { ConfigStore, mergeWithDefaults } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
import { findRepoLocalLinkedRepository } from "./repo-local-registry";
import type { FrameworkConfig, LinkedRepository } from "./types";

/** Root classification shared by install and doctor. `core` = no configured root. */
export type RootKind = "core" | "working" | "companion" | "hub";

/** How the configured root was found. */
export type RootOrigin = "env" | "registry" | "local" | "none";

export interface RootContext {
  /** Kind of the resolved configured root (from `config.type`), or `core`. */
  kind: RootKind;
  origin: RootOrigin;
  rootPath?: string;
  /** Merged config of the resolved root; absent for `core`. */
  config?: FrameworkConfig;
  repositoryId?: string;
  /** Repo-local `registry.yaml` repository entry for cwd, when present. */
  linkedRepository: LinkedRepository | null;
  resolution: CompanionResolutionResult;
}

export interface RootContextDeps {
  globalConfigStore?: GlobalConfigStore;
}

const emptyResolution = (): CompanionResolutionResult => ({
  match: null,
  ambiguousMatches: [],
  failures: [],
});

function kindForConfig(config: FrameworkConfig): Exclude<RootKind, "core"> {
  return config.type === "hub" ? "hub" : config.type === "working" ? "working" : "companion";
}

async function loadRootConfig(rootPath: string): Promise<FrameworkConfig> {
  const configPath = path.join(rootPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  return mergeWithDefaults(await new ConfigStore(configPath).load());
}

export async function resolveRootContext(
  cwd = process.cwd(),
  deps: RootContextDeps = {},
): Promise<RootContext> {
  const resolvedCwd = path.resolve(cwd);
  const linkedRepository = await findRepoLocalLinkedRepository(resolvedCwd);

  const envRootPath = process.env.MATE_ARTIFACT_PATH;
  if (envRootPath) {
    const rootPath = path.resolve(envRootPath);
    const config = await loadRootConfig(rootPath);
    return {
      kind: kindForConfig(config),
      origin: "env",
      rootPath,
      config,
      repositoryId: process.env.MATE_REPO_ID ?? linkedRepository?.id,
      linkedRepository,
      resolution: emptyResolution(),
    };
  }

  const resolver = new CompanionResolver(deps.globalConfigStore ?? new GlobalConfigStore());
  const resolution = await resolver.resolveWithDiagnostics(resolvedCwd);
  if (resolution.match) {
    const rootPath = resolution.match.companionPath;
    const config = await loadRootConfig(rootPath);
    return {
      kind: kindForConfig(config),
      origin: "registry",
      rootPath,
      config,
      repositoryId: linkedRepository?.id ?? resolution.match.repositoryId,
      linkedRepository,
      resolution,
    };
  }

  const localRoot = await findConfiguredRoot(resolvedCwd);
  if (localRoot) {
    const config = await loadRootConfig(localRoot);
    return {
      kind: kindForConfig(config),
      origin: "local",
      rootPath: localRoot,
      config,
      linkedRepository,
      resolution,
    };
  }

  return { kind: "core", origin: "none", linkedRepository, resolution };
}

/** Nearest ancestor of `cwd` (inclusive) holding `.<framework>/config/framework.yaml`. */
export async function findConfiguredRoot(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      await fs.access(path.join(dir, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"));
      return dir;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
