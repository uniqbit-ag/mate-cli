/**
 * Stable Mate launch environment contract shared by the CLI (writer) and the
 * OpenCode runtime plugins (readers). The CLI materializes these variables for
 * every managed session; plugins must consume them through this module instead
 * of hard-coding variable names.
 *
 * Every name is `MATE_`-prefixed, which is what lets a reader treat "any of
 * these present" as "a Mate launch configured this process".
 */
export const MATE_ENV = {
  frameworkName: "MATE_NAME",
  version: "MATE_VERSION",
  companionPath: "MATE_ARTIFACT_PATH",
  wrapperBinPath: "MATE_WRAPPER_BIN_PATH",
  repositoryPath: "MATE_REPO_PATH",
  repositoryId: "MATE_REPO_ID",
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
