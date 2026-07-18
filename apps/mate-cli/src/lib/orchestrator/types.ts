export class MateError extends Error {}

export class ConfigError extends MateError {}

export class RepositoryNotSelectedError extends MateError {}

export class RepositoryNotFoundError extends MateError {}

export class AmbiguousCompanionError extends MateError {
  constructor(paths: string[]) {
    super(
      [
        "mate: this working repo is linked from multiple companions.",
        "",
        "  Re-run in a TTY to choose one, or set MATE_ARTIFACT_PATH.",
        ...paths.map((companionPath) => `  - ${companionPath}`),
      ].join("\n"),
    );
  }
}

export class ToolNotAllowedError extends MateError {}

export class LaunchPreflightError extends MateError {}

export class WorkingRepoRequiredError extends MateError {
  constructor(command = "launch") {
    super(
      [
        `mate: ${command} must be run from a working repository directory.`,
        "",
        "  Current directory does not match any linked working repository.",
        `  Run \`mate ${command}\` from inside a directory you have registered with:`,
        "",
        "    mate companion link",
        "",
        "  To see linked repositories: mate companion list",
      ].join("\n"),
    );
  }
}

export type CompanionSource = "git" | "existing" | "local";

export interface PolicySettings {
  allowedAgents: string[];
}

export interface PolicyOverride {
  allowedAgents?: string[];
}

export interface PolicyProfile extends PolicySettings {
  name: string;
}

export interface LinkedRepository {
  id: string;
  path: string;
  profile: string;
  overrides?: PolicyOverride;
}

export interface CliToolConfig {
  name: string;
  redirectCwd: "companionRoot" | false;
}

export type OpenSpecSchemaProfile = "mate-v1" | (string & {});
export type GitModeProfile = "auto";

export interface CapabilityConfig {
  name: string;
  schemaProfile?: OpenSpecSchemaProfile;
}

export interface FrameworkConfig {
  type?: "working" | "companion";
  git?: GitModeProfile;
  profiles: Record<string, PolicyProfile>;
  capabilities?: CapabilityConfig[];
  cliTools?: CliToolConfig[];
  packageManagers?: string[];
}

export interface WorkingRepoConfig {
  repos: LinkedRepository[];
}

export interface LaunchRequest {
  tool: string;
  args: string[];
  skipGit?: boolean;
}

export interface LaunchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
