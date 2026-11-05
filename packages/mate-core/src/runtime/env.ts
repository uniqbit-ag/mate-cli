import fs from "node:fs";

import { MATE_ENV } from "./env-names";
import { FRAMEWORK_NAME } from "./framework";
import { isLinkedWorktreeOf } from "./git-layout";
import { isWithin } from "./physical-path";
import { isCapabilityEnabled, policyDocument, readCompanionPolicy } from "./policy";
import { resolveProjection, type ResolvedProjection } from "./projection";

export { MATE_ENV, type MateEnvVariable } from "./env-names";

/**
 * Normalized companion runtime context. Values come from the Mate launch
 * environment when it is present, and from the durable projection at the
 * Projection Root otherwise.
 */
export type CompanionRuntimeContext = {
  frameworkName: string;
  companionPath: string;
  repositoryPath: string;
  repositoryId: string;
  policyJson: string;
  graphifyEnabled: boolean;
  gitAutoModeEnabled: boolean;
  reactDoctorEnabled: boolean;
};

/**
 * Any `MATE_*` variable present means a Mate launch configured this process,
 * so the environment is authoritative and the projection is not read.
 */
export function hasLaunchEnvironment(env: Record<string, string | undefined>): boolean {
  return Object.values(MATE_ENV).some((name) => env[name] !== undefined);
}

function fromEnvironment(env: Record<string, string | undefined>): CompanionRuntimeContext {
  return {
    frameworkName: env[MATE_ENV.frameworkName] ?? FRAMEWORK_NAME,
    companionPath: env[MATE_ENV.companionPath] ?? "",
    repositoryPath: env[MATE_ENV.repositoryPath] ?? "",
    repositoryId: env[MATE_ENV.repositoryId] ?? "",
    policyJson: env[MATE_ENV.policyJson] ?? "{}",
    graphifyEnabled: env[MATE_ENV.graphifyEnabled] === "1",
    gitAutoModeEnabled: env[MATE_ENV.gitAutoMode] === "1",
    reactDoctorEnabled: env[MATE_ENV.reactDoctorEnabled] === "1",
  };
}

/**
 * The resolved context together with the projection it came from, so a reader
 * that surfaces session state can judge that projection's freshness without a
 * second upward walk. `projection` is null for a managed session.
 */
export interface CompanionRuntimeResolution {
  context: CompanionRuntimeContext;
  projection: ResolvedProjection | null;
}

/**
 * The environment always wins: the projection is consulted only when no
 * `MATE_*` variable is set, so a managed session never reads it and no stale
 * or malformed projection can degrade a session a Mate launch configured.
 * Only a session moved into a linked worktree of its repository reads that
 * worktree's projection, for its repository path alone.
 */
export function resolveCompanionRuntime(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): CompanionRuntimeResolution {
  if (hasLaunchEnvironment(env)) {
    const context = fromEnvironment(env);
    const worktree = linkedWorktreePath(context, cwd);
    return {
      context: worktree ? { ...context, repositoryPath: worktree } : context,
      projection: null,
    };
  }

  const projection = resolveProjection(cwd);
  if (!projection) return { context: fromEnvironment(env), projection: null };

  const policy = readCompanionPolicy(projection.companionPath);
  return {
    projection,
    context: {
      frameworkName: FRAMEWORK_NAME,
      companionPath: projection.companionPath,
      repositoryPath: projection.repositoryPath,
      repositoryId: projection.repositoryId,
      policyJson: policyDocument(policy),
      graphifyEnabled: isCapabilityEnabled(policy, "graphify"),
      gitAutoModeEnabled: policy.gitAutoMode,
      reactDoctorEnabled: isCapabilityEnabled(policy, "react-doctor"),
    },
  };
}

/**
 * The one exception to the environment's precedence: a managed session moved into a
 * linked worktree of its Working Repository whose own projection names the same
 * companion and repository id reports that worktree. Files only, no `git` process, and
 * nothing is read while `cwd` lies inside the environment's repository. Any mismatch or
 * error leaves the environment's answer.
 */
function linkedWorktreePath(context: CompanionRuntimeContext, cwd: string): string | null {
  if (!context.repositoryPath || !context.companionPath) return null;
  const realPath = fs.realpathSync;
  try {
    const repository = realPath(context.repositoryPath);
    if (isWithin(realPath(cwd), repository)) return null;
    const projection = resolveProjection(cwd);
    if (!projection) return null;
    const worktree = realPath(projection.repoRoot);
    if (
      worktree === repository ||
      realPath(projection.repositoryPath) !== worktree ||
      realPath(projection.companionPath) !== realPath(context.companionPath) ||
      projection.repositoryId !== context.repositoryId ||
      !isLinkedWorktreeOf(worktree, repository)
    ) {
      return null;
    }
    return projection.repositoryPath;
  } catch {
    return null;
  }
}

export function readCompanionRuntimeContext(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): CompanionRuntimeContext {
  return resolveCompanionRuntime(env, cwd).context;
}

/**
 * A session is Mate-managed when a companion path resolved. A companion-scoped
 * launch intentionally has no working repository.
 */
export function isManagedCompanionContext(context: CompanionRuntimeContext): boolean {
  return Boolean(context.companionPath);
}
