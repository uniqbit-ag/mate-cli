import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import {
  CompanionResolver,
  type CompanionResolutionResult,
  findRepoLocalLinkedRepository,
} from "./repository-link";
import { ConfigStore, defaultConfig, mergeWithDefaults } from "./config-store";
import { GlobalConfigStore } from "./global-config-store";
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
  /** `false` resolves without repairing the repo-local registry. */
  write?: boolean;
}

const emptyResolution = (): CompanionResolutionResult => ({
  match: null,
  ambiguousMatches: [],
  failures: [],
});

function kindForConfig(config: Pick<FrameworkConfig, "type">): Exclude<RootKind, "core"> {
  return config.type === "hub" ? "hub" : config.type === "working" ? "working" : "companion";
}

/** The kind a folder's own `framework.yaml` names; null without one. A file that cannot be read or parsed counts as a companion's. */
export async function localRootKind(folder: string): Promise<Exclude<RootKind, "core"> | null> {
  try {
    const raw = await fs.readFile(
      path.join(folder, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "utf8",
    );
    return kindForConfig((parse(raw) as Pick<FrameworkConfig, "type"> | null) ?? {});
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "companion";
  }
}

async function loadRootConfig(
  rootPath: string,
  write?: boolean,
  failures: CompanionResolutionResult["failures"] = [],
): Promise<FrameworkConfig> {
  const configPath = path.join(rootPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  const missing =
    write === false &&
    (await fs.access(configPath).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    ));
  if (missing) {
    failures.push({ companionPath: rootPath, message: `${configPath} is missing.` });
    return mergeWithDefaults(defaultConfig());
  }
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
    const resolution = emptyResolution();
    const config = await loadRootConfig(rootPath, deps.write, resolution.failures);
    return {
      kind: kindForConfig(config),
      origin: "env",
      rootPath,
      config,
      repositoryId: process.env.MATE_REPO_ID ?? linkedRepository?.id,
      linkedRepository,
      resolution,
    };
  }

  const resolver = new CompanionResolver(deps.globalConfigStore ?? new GlobalConfigStore());
  const resolution = await resolver.resolveWithDiagnostics(resolvedCwd, { write: deps.write });
  if (resolution.match) {
    const rootPath = resolution.match.companionPath;
    const config = await loadRootConfig(rootPath, deps.write, resolution.failures);
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
async function findConfiguredRoot(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the nearest ancestor wins, so stop at the first hit
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
