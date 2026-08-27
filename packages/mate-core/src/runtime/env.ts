import { MATE_ENV } from "./env-names";
import { FRAMEWORK_NAME } from "./framework";
import { isCapabilityEnabled, readCompanionPolicy } from "./policy";
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
function hasLaunchEnvironment(env: Record<string, string | undefined>): boolean {
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
 */
export function resolveCompanionRuntime(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): CompanionRuntimeResolution {
  if (hasLaunchEnvironment(env)) return { context: fromEnvironment(env), projection: null };

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
      policyJson: JSON.stringify({ allowedAgents: policy.allowedAgents }),
      graphifyEnabled: isCapabilityEnabled(policy, "graphify"),
      gitAutoModeEnabled: policy.gitAutoMode,
      reactDoctorEnabled: isCapabilityEnabled(policy, "react-doctor"),
    },
  };
}

export function readCompanionRuntimeContext(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): CompanionRuntimeContext {
  return resolveCompanionRuntime(env, cwd).context;
}

/**
 * A session is Mate-managed only when both the companion path and the working
 * repository path resolved. Plugins must stay inert otherwise.
 */
export function isManagedCompanionContext(context: CompanionRuntimeContext): boolean {
  return Boolean(context.companionPath && context.repositoryPath);
}
