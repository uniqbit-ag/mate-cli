/**
 * Stable Mate launch environment contract shared by the CLI (writer) and the
 * OpenCode runtime plugins (readers). The CLI materializes these variables for
 * every managed session; plugins must consume them through this module instead
 * of hard-coding variable names.
 */
export const MATE_ENV = {
  frameworkName: "MATE_NAME",
  version: "MATE_VERSION",
  companionPath: "MATE_ARTIFACT_PATH",
  wrapperBinPath: "MATE_WRAPPER_BIN_PATH",
  repositoryPath: "MATE_REPO_PATH",
  repositoryId: "MATE_REPO_ID",
  repositoryProfile: "MATE_REPO_PROFILE",
  policyJson: "MATE_POLICY_JSON",
  graphifyEnabled: "MATE_GRAPHIFY_ENABLED",
  gitAutoMode: "MATE_GIT_AUTO_MODE",
  reactDoctorEnabled: "MATE_REACT_DOCTOR_ENABLED",
  reactDoctorBinPath: "MATE_REACT_DOCTOR_BIN_PATH",
  /**
   * Serialized `MateGuidanceFile` JSON built by the CLI per managed launch.
   * Session-scoped: the plugin consumes it at startup and masks it from
   * spawned shells so it never leaks into subprocess environments.
   */
  guidanceJson: "MATE_GUIDANCE_JSON",
} as const;

export type MateEnvVariable = (typeof MATE_ENV)[keyof typeof MATE_ENV];

/**
 * Normalized companion runtime context derived from the Mate launch
 * environment. Contains no repository-specific defaults; every value comes
 * from the active session environment.
 */
export type CompanionRuntimeContext = {
  frameworkName: string;
  companionPath: string;
  repositoryPath: string;
  repositoryId: string;
  repositoryProfile: string;
  policyJson: string;
  graphifyEnabled: boolean;
  gitAutoModeEnabled: boolean;
  reactDoctorEnabled: boolean;
};

export function readCompanionRuntimeContext(
  env: Record<string, string | undefined> = process.env,
): CompanionRuntimeContext {
  return {
    frameworkName: env[MATE_ENV.frameworkName] ?? "mate",
    companionPath: env[MATE_ENV.companionPath] ?? "",
    repositoryPath: env[MATE_ENV.repositoryPath] ?? "",
    repositoryId: env[MATE_ENV.repositoryId] ?? "",
    repositoryProfile: env[MATE_ENV.repositoryProfile] ?? "",
    policyJson: env[MATE_ENV.policyJson] ?? "{}",
    graphifyEnabled: env[MATE_ENV.graphifyEnabled] === "1",
    gitAutoModeEnabled: env[MATE_ENV.gitAutoMode] === "1",
    reactDoctorEnabled: env[MATE_ENV.reactDoctorEnabled] === "1",
  };
}

/**
 * A session is Mate-managed only when the CLI exported both the companion
 * path and the working repository path. Plugins must stay inert otherwise.
 */
export function isManagedCompanionContext(context: CompanionRuntimeContext): boolean {
  return Boolean(context.companionPath && context.repositoryPath);
}
