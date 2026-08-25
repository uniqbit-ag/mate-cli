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

export interface LinkedRepository {
  id: string;
  path: string;
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

export type FrameworkType = "working" | "companion" | "hub";

export interface HubMemberSource {
  kind: "git" | "local";
  url?: string;
  ref?: string;
  path?: string;
}

export interface HubMember {
  id: string;
  path: string;
  source: HubMemberSource;
  materializedCommit?: string;
}

export interface HubConfig {
  companions: HubMember[];
}

/**
 * Distribution-name-keyed semver ranges (e.g. `{ mate: ">=0.15.0" }` or
 * `{ "acme-mate": ">=1.2.0" }`). A running CLI only checks the key matching
 * its own distribution name; foreign keys are ignored.
 */
export type EngineConstraints = Record<string, string>;

/**
 * Registration policy for a companion-declared plugin. `required` is a
 * distribution prerogative and is rejected for declared plugins.
 */
export type PluginDeclarationPolicy = "default" | "optional";

/**
 * A companion-declared npm plugin: installed by setup/install into the
 * companion's own shared plugin workspace (`.mate/plugins/`) and loaded
 * from there on every invocation. Declaration both registers and activates
 * the plugin; dynamic plugins do not need a separate `capabilities` entry.
 */
export interface PluginDeclaration {
  /** npm package name (e.g. `@acme/custom-plugin`). */
  package: string;
  /**
   * Exact version, semver range, or a moving tag (`latest`, `canary`). Moving
   * tags are re-resolved via `npm update` on every `mate install`; anything
   * else is pinned and only re-resolves when the declaration changes.
   */
  version: string;
  /** Registration policy; absent means `optional`. */
  policy?: PluginDeclarationPolicy;
  /** Opaque plugin parameters, passed to the plugin factory after resolution. */
  config?: unknown;
}

export interface FrameworkConfig {
  type?: FrameworkType;
  git?: GitModeProfile;
  hub?: HubConfig;
  allowedAgents: string[];
  capabilities?: CapabilityConfig[];
  plugins?: PluginDeclaration[];
  migrations?: string[];
  cliTools?: CliToolConfig[];
  packageManagers?: string[];
  engines?: EngineConstraints;
}

export interface CompanionRegistryConfig {
  repos: LinkedRepository[];
}

export interface LaunchRequest {
  tool: string;
  args: string[];
  skipGit?: boolean;
  interactiveGit?: boolean;
}

export interface LaunchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
