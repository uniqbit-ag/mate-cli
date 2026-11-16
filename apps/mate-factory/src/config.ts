import fs from "node:fs";

import { parse } from "yaml";

/**
 * The appliance's configuration surface.
 *
 * Every setting is readable from an environment variable and from a file, and
 * the environment wins where both are present — the environment is the more
 * specific act. A value that is present but unusable stops startup naming the
 * setting and the value, because a container that quietly serves on a port
 * nobody asked for is worse than one that does not start.
 *
 * The file exists for the values an operator would rather not put in a process
 * listing — the agent's credentials above all.
 */

export const CONFIG_FILE_ENV = "MATE_APPLIANCE_CONFIG";
export const DEFAULT_CONFIG_FILE = "/etc/mate/appliance.yaml";

export interface GitLocation {
  /** The remote to clone from. */
  url: string;
  /** The directory name under the companions directory. Defaults to the repository name. */
  directory: string;
}

export interface PluginRegistry {
  /** Npm scope including the leading `@`, e.g. `@acme`. */
  scope: string;
  /** Registry base URL, always ending in `/`. */
  url: string;
  token: string;
}

/** The Workset agents' Claude Code credential: a subscription token or an API key. */
export type FactoryCredentialName = "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";

export interface FactoryConfig {
  enabled: boolean;
  /** Handed to the factory broker only; null when none was supplied. Never printed. */
  credential: { name: FactoryCredentialName; value: string } | null;
  /** Git URLs of Working Repositories Worksets may clone; handed to Studio. */
  repositories: string[];
  /** How many Workset runs Studio's AFK runner starts at once. */
  maxRuns: number;
  /** How many of those runs may be in a build stage at once. */
  maxBuilds: number;
  /** The time budget of one stage of a run, in minutes. */
  stageMinutes: number;
  /** How many Workset containers run at once. */
  maxWorksets: number;
  /** Minutes without activity before a Workset container is stopped; 0 never stops one. */
  idleMinutes: number;
  /** Each Workset container's memory limit, swap included, as a Docker size such as `4g`. */
  worksetMemory: string;
  /** The memory limit during an agent stage; builds and sessions get `worksetMemory`. */
  agentMemory: string;
  /** Each Workset container's pid limit. */
  worksetPids: number;
  /** Each Workset container's CPU limit; null sets none. */
  worksetCpus: string | null;
  /** The author and committer of every commit the factory makes. */
  gitName: string;
  gitEmail: string;
}

/** Factory commits are told apart by name; `.invalid` never reaches a real mailbox. */
export const FACTORY_GIT_AUTHOR = { name: "Mate factory", email: "factory@mate.invalid" };

type FactoryRunner = Omit<FactoryConfig, "enabled" | "credential" | "repositories">;
const RUNNER_DEFAULTS: FactoryRunner = {
  maxRuns: 2,
  maxBuilds: 2,
  stageMinutes: 60,
  maxWorksets: 3,
  idleMinutes: 15,
  worksetMemory: "4g",
  agentMemory: "1536m",
  worksetPids: 1024,
  worksetCpus: null,
  gitName: FACTORY_GIT_AUTHOR.name,
  gitEmail: FACTORY_GIT_AUTHOR.email,
};

export interface ApplianceConfig {
  companionsDir: string;
  companionRepos: GitLocation[];
  companion: string | null;
  /** The one audience of the selected companion this container serves; null serves the base. */
  audience: string | null;
  studioPort: number;
  studioHost: string;
  studioWritable: boolean;
  /** Effective: off whenever the write path is off. */
  studioTerminal: boolean;
  studioDetachMinutes: number;
  /** Never printed; reaches Studio through its environment only. */
  studioToken: string | null;
  studioAllowedHosts: string[];
  studioPublicOrigin: string | null;
  gitSync: boolean;
  gitUserName: string | null;
  gitUserEmail: string | null;
  /** Passed into the agent sessions' environment untouched, and never written into a companion. */
  credentials: Record<string, string>;
  /** Scoped plugin registry; null leaves startup setup disabled. Startup-only, never forwarded to Studio. */
  pluginRegistry: PluginRegistry | null;
  /** Startup-only credential for cloning private companions; never forwarded to Studio. */
  gitCloneToken: string | null;
  /** Appended to the error for a missing companion, e.g. the operator's setup command. */
  setupHint: string | null;
  /** Settings this container no longer has but the operator still sets; warned about, not refused. */
  removed: string[];
  factory: FactoryConfig;
}

/** Settings the container dropped; still recognised so a stale one is named. */
export const REMOVED_SETTINGS = [
  "MATE_AGENT_PORT",
  "MATE_AGENT_HOST",
  "MATE_ALLOWED_PLUGINS",
] as const;
const REMOVED_KEYS: Record<(typeof REMOVED_SETTINGS)[number], string> = {
  MATE_AGENT_PORT: "agentPort",
  MATE_AGENT_HOST: "agentHost",
  MATE_ALLOWED_PLUGINS: "allowedPlugins",
};

/** Mirrors Studio's own minimum for a pinned token. */
const MIN_TOKEN_LENGTH = 32;

export class ConfigError extends Error {
  constructor(
    readonly setting: string,
    readonly value: string,
    reason: string,
  ) {
    super(`${setting}: ${reason} (got ${JSON.stringify(value)})`);
    this.name = "ConfigError";
  }
}

interface Setting {
  /** The environment variable an operator sets. */
  env: string;
  /** The key under which the same setting appears in the configuration file. */
  key: string;
  meaning: string;
  /** Rendered in the documented table; null where the setting has no default. */
  default: string | null;
  required: boolean;
}

/**
 * The single table the deployment page documents and the entrypoint reads.
 * A setting absent here is a setting the container does not have.
 */
export const SETTINGS: Setting[] = [
  {
    env: "MATE_COMPANIONS_DIR",
    key: "companionsDir",
    meaning: "The directory holding the Companion Repositories the container serves.",
    default: "/companions",
    required: false,
  },
  {
    env: "MATE_COMPANION_REPOS",
    key: "companionRepos",
    meaning:
      "Git locations to check out into the companions directory when nothing is present at their destination. One per line or comma-separated, each `url` or `url=directory`.",
    default: null,
    required: false,
  },
  {
    env: "MATE_COMPANION",
    key: "companion",
    meaning:
      "Which discovered companion agent sessions run against, by directory name or absolute path. Required only where more than one is discovered.",
    default: null,
    required: false,
  },
  {
    env: "MATE_AUDIENCE",
    key: "audience",
    meaning:
      "The audience of the selected companion this container serves, as declared under `audiences:` in its `framework.yaml`. Its plugins load beside the base plugins and its Studio default agent applies. An audience the companion does not declare stops startup. Unset: the base configuration only. One container serves one audience.",
    default: null,
    required: false,
  },
  {
    env: "MATE_STUDIO_PORT",
    key: "studioPort",
    meaning: "The port Studio is served on.",
    default: "4097",
    required: false,
  },
  {
    env: "MATE_STUDIO_HOST",
    key: "studioHost",
    meaning: "The interface Studio binds.",
    default: "0.0.0.0",
    required: false,
  },
  {
    env: "MATE_STUDIO_WRITABLE",
    key: "studioWritable",
    meaning: "Whether Studio's save path is reachable.",
    default: "true",
    required: false,
  },
  {
    env: "MATE_STUDIO_TERMINAL",
    key: "studioTerminal",
    meaning:
      "Whether Studio offers the agent terminal. It needs the save path: with `MATE_STUDIO_WRITABLE` off, the terminal is off too.",
    default: "true",
    required: false,
  },
  {
    env: "MATE_STUDIO_DETACH_MINUTES",
    key: "studioDetachMinutes",
    meaning: "How long a terminal session keeps running with no browser tab attached, in minutes.",
    default: "30",
    required: false,
  },
  {
    env: "MATE_STUDIO_TOKEN",
    key: "studioToken",
    meaning:
      "Pins Studio's access token (at least 32 characters) so it survives restarts and stays out of the log. Without it, Studio generates one per start and prints its address.",
    default: null,
    required: false,
  },
  {
    env: "MATE_STUDIO_ALLOWED_HOSTS",
    key: "studioAllowedHosts",
    meaning:
      "Additional exact `host[:port]` values Studio answers to, comma-separated — the proxy's public host, or `localhost:<port>` when the published port differs.",
    default: null,
    required: false,
  },
  {
    env: "MATE_STUDIO_PUBLIC_ORIGIN",
    key: "studioPublicOrigin",
    meaning:
      "The exact `https://host[:port]` users open when a proxy terminates TLS in front of Studio.",
    default: null,
    required: false,
  },
  {
    env: "MATE_GIT_SYNC",
    key: "gitSync",
    meaning: "Whether the companion's own Git synchronization runs.",
    default: "false",
    required: false,
  },
  {
    env: "MATE_GIT_USER_NAME",
    key: "gitUserName",
    meaning: "The Git author name used for any commit the container makes.",
    default: null,
    required: false,
  },
  {
    env: "MATE_GIT_USER_EMAIL",
    key: "gitUserEmail",
    meaning: "The Git author email used for any commit the container makes.",
    default: null,
    required: false,
  },
  {
    env: "MATE_AGENT_CREDENTIALS",
    key: "credentials",
    meaning:
      "The agents' own credentials, passed into every agent session's environment untouched. A file is the sensible place for these; in the environment, `NAME=value` pairs one per line.",
    default: null,
    required: false,
  },
  {
    env: "MATE_PLUGIN_REGISTRY",
    key: "pluginRegistry",
    meaning:
      "`<scope>=<registry-url>`, e.g. `@acme=https://registry.acme.test/api/npm/`. Setting it opts in to startup restore: the selected companion's locked plugins are installed from this scoped registry before Studio starts. Requires `MATE_PLUGIN_REGISTRY_TOKEN`. Unset: startup installs nothing. Startup-only; never forwarded to Studio or agent sessions.",
    default: null,
    required: false,
  },
  {
    env: "MATE_PLUGIN_REGISTRY_TOKEN",
    key: "pluginRegistryToken",
    meaning:
      "The read token for the scoped plugin registry. Startup-only; never forwarded to Studio or agent sessions.",
    default: null,
    required: false,
  },
  {
    env: "MATE_GIT_CLONE_TOKEN",
    key: "gitCloneToken",
    meaning:
      "A read token used only to clone a private location from `MATE_COMPANION_REPOS`; it is never written into the remote URL, command arguments or checkout, and is not forwarded to Studio or agent sessions.",
    default: null,
    required: false,
  },
  {
    env: "MATE_SETUP_HINT",
    key: "setupHint",
    meaning:
      "Text added to the error reported when no companion is found, such as the command that sets one up.",
    default: null,
    required: false,
  },
  {
    env: "MATE_FACTORY",
    key: "factory",
    meaning:
      'Factory mode: Sysbox and an inner Docker daemon run Workset containers. Needs the container started as root (`user: "0"`), privileged, with volumes at `/var/lib/docker`, `/var/lib/sysbox` and `/var/lib/mate-factory`. Studio and agent sessions still run as `mate`.',
    default: "false",
    required: false,
  },
  {
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    key: "claudeCodeOauthToken",
    meaning:
      "Factory mode: a Claude subscription token (from `claude setup-token`) for Workset agents. Handed only to the factory broker, never to Studio or appliance sessions. Set this or `ANTHROPIC_API_KEY`, not both.",
    default: null,
    required: false,
  },
  {
    env: "ANTHROPIC_API_KEY",
    key: "anthropicApiKey",
    meaning:
      "Factory mode: an Anthropic API key for Workset agents. Handed only to the factory broker, never to Studio or appliance sessions. Set this or `CLAUDE_CODE_OAUTH_TOKEN`, not both.",
    default: null,
    required: false,
  },
  {
    env: "MATE_FACTORY_REPOSITORIES",
    key: "factoryRepositories",
    meaning:
      "Factory mode: Git URLs of Working Repositories Worksets may be created for and cloned from, one per line or comma-separated. Optional: repositories can also be added in Studio, to the companion's `factory.local.yaml`. Studio offers each by its `org/repository` name, besides the repositories linked to the companion; a linked repository wins over `factory.local.yaml`, which wins over this setting.",
    default: null,
    required: false,
  },
  {
    env: "MATE_FACTORY_PARALLEL_RUNS",
    key: "factoryParallelRuns",
    meaning:
      "Factory mode: how many AFK runs work at once; others wait in order. Workset containers follow from it: the parallel runs plus one, so one stays free for a person's session.",
    default: "2",
    required: false,
  },
  {
    env: "MATE_FACTORY_MAX_RUNS",
    key: "factoryMaxRuns",
    meaning:
      "Factory mode: the older name of `MATE_FACTORY_PARALLEL_RUNS`. Setting both to different values stops startup.",
    default: null,
    required: false,
  },
  {
    env: "MATE_FACTORY_PARALLEL_BUILDS",
    key: "factoryParallelBuilds",
    meaning:
      "Factory mode: how many of the parallel runs may be in a build stage (apply) at once; a build waits for a build slot while agent stages go ahead. At most `MATE_FACTORY_PARALLEL_RUNS`.",
    default: "2",
    required: false,
  },
  {
    env: "MATE_FACTORY_STAGE_MINUTES",
    key: "factoryStageMinutes",
    meaning:
      "Factory mode: the time budget of one stage of a Workset run, in minutes; a stage past it fails.",
    default: "60",
    required: false,
  },
  {
    env: "MATE_FACTORY_MAX_WORKSETS",
    key: "factoryMaxWorksets",
    meaning:
      "Factory mode: overrides how many Workset containers run at once, by default `MATE_FACTORY_PARALLEL_RUNS` plus one. Starting another stops the least recently used idle one; when none is idle, an AFK run waits and a session is refused. At least `MATE_FACTORY_PARALLEL_RUNS`.",
    default: null,
    required: false,
  },
  {
    env: "MATE_FACTORY_IDLE_MINUTES",
    key: "factoryIdleMinutes",
    meaning:
      "Factory mode: minutes a Workset container may sit with no session and no command before it is stopped; its worktree and home are kept. `0` never stops one.",
    default: "15",
    required: false,
  },
  {
    env: "MATE_FACTORY_WORKSET_MEMORY",
    key: "factoryWorksetMemory",
    meaning:
      "Factory mode: each Workset container's memory limit, swap included, as a Docker size such as `4g` or `512m`. Covers everything the agent starts in it, nested containers too.",
    default: "4g",
    required: false,
  },
  {
    env: "MATE_FACTORY_AGENT_MEMORY",
    key: "factoryAgentMemory",
    meaning:
      "Factory mode: a Workset container's memory limit during an agent stage (clarify, explore, propose, revise, publish), swap included. Builds and a person's session get `MATE_FACTORY_WORKSET_MEMORY`. At most `MATE_FACTORY_WORKSET_MEMORY`.",
    default: "1536m",
    required: false,
  },
  {
    env: "MATE_FACTORY_WORKSET_PIDS",
    key: "factoryWorksetPids",
    meaning: "Factory mode: each Workset container's process limit.",
    default: "1024",
    required: false,
  },
  {
    env: "MATE_FACTORY_WORKSET_CPUS",
    key: "factoryWorksetCpus",
    meaning:
      "Factory mode: each Workset container's CPU limit, such as `2` or `1.5`. Unset sets none.",
    default: null,
    required: false,
  },
  {
    env: "MATE_FACTORY_GIT_NAME",
    key: "factoryGitName",
    meaning:
      "Factory mode: the author and committer name of every commit the factory makes, its Workset commits and publications. Name a bot account here when the factory pushes to a forge.",
    default: FACTORY_GIT_AUTHOR.name,
    required: false,
  },
  {
    env: "MATE_FACTORY_GIT_EMAIL",
    key: "factoryGitEmail",
    meaning:
      "Factory mode: the author and committer email of every commit the factory makes. The default's `.invalid` domain never belongs to a real mailbox or account.",
    default: FACTORY_GIT_AUTHOR.email,
    required: false,
  },
  {
    env: CONFIG_FILE_ENV,
    key: "",
    meaning: "Where the configuration file is read from.",
    default: DEFAULT_CONFIG_FILE,
    required: false,
  },
];

type FileConfig = Record<string, unknown>;

export function readConfigFile(file: string): FileConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // No file is the ordinary case: everything has an environment variable.
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new ConfigError(file, "", `is not readable as YAML: ${(error as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(file, String(parsed), "must contain a mapping of settings");
  }
  return parsed as FileConfig;
}

function rawValue(
  setting: Setting,
  env: NodeJS.ProcessEnv,
  file: FileConfig,
): { source: "env" | "file"; value: unknown } | null {
  const fromEnv = env[setting.env];
  // The environment wins, and an explicitly empty variable is still a value:
  // it is how an operator clears a setting the file supplies.
  if (fromEnv !== undefined) return { source: "env", value: fromEnv };
  if (setting.key !== "" && file[setting.key] !== undefined) {
    return { source: "file", value: file[setting.key] };
  }
  return null;
}

function port(setting: Setting, raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    throw new ConfigError(setting.env, text, "must be a whole number");
  }
  const value = Number(text);
  if (value < 1 || value > 65535) {
    throw new ConfigError(setting.env, text, "must be a port between 1 and 65535");
  }
  return value;
}

function bool(setting: Setting, raw: unknown, fallback: boolean): boolean {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const text = String(raw).trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(text)) return true;
  if (["false", "no", "0", "off"].includes(text)) return false;
  throw new ConfigError(setting.env, String(raw), "must be true or false");
}

function text(raw: unknown, fallback: string): string {
  if (raw === null || raw === undefined) return fallback;
  const value = String(raw).trim();
  return value === "" ? fallback : value;
}

function optionalText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value === "" ? null : value;
}

/** Mirrors the audience-name rule `mate` validates a companion's `audiences:` keys against. */
const AUDIENCE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

function audienceName(setting: Setting, raw: unknown): string | null {
  const value = optionalText(raw);
  if (value === null) return null;
  if (!AUDIENCE_NAME.test(value)) {
    throw new ConfigError(
      setting.env,
      value,
      "must be an audience name: lowercase letters, digits and hyphens, starting with a letter",
    );
  }
  return value;
}

/** `https://host/acme.git` → `acme`. */
export function directoryForUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

function gitLocations(setting: Setting, raw: unknown): GitLocation[] {
  if (raw === null || raw === undefined || raw === "") return [];

  const entries: Array<{ url: unknown; directory?: unknown }> = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") entries.push({ url: entry });
      else if (entry !== null && typeof entry === "object") {
        entries.push(entry as { url: unknown; directory?: unknown });
      } else {
        throw new ConfigError(
          setting.env,
          String(entry),
          "must be a URL or a {url, directory} map",
        );
      }
    }
  } else if (typeof raw === "string") {
    for (const line of raw.split(/[\n,]/)) {
      const value = line.trim();
      if (value === "") continue;
      const separator = value.indexOf("=");
      entries.push(
        separator === -1
          ? { url: value }
          : { url: value.slice(0, separator).trim(), directory: value.slice(separator + 1).trim() },
      );
    }
  } else {
    throw new ConfigError(setting.env, String(raw), "must be a list of Git locations");
  }

  return entries.map((entry) => {
    const url = optionalText(entry.url);
    if (url === null) {
      throw new ConfigError(setting.env, String(entry.url ?? ""), "names a location with no URL");
    }
    const directory = optionalText(entry.directory) ?? directoryForUrl(url);
    if (directory === "" || directory.includes("/") || directory === "..") {
      throw new ConfigError(
        setting.env,
        directory,
        "must be a single directory name under the companions directory",
      );
    }
    return { url, directory };
  });
}

function positiveInteger(setting: Setting, raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new ConfigError(setting.env, value, "must be a whole number of at least 1");
  }
  return Number(value);
}

function nonNegativeInteger(setting: Setting, raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) throw new ConfigError(setting.env, value, "must be a whole number");
  return Number(value);
}

/** A Docker size: a whole number with an optional `b`, `k`, `m` or `g` unit. */
const SIZE_UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** Bytes in a size `dockerSize` accepted. */
function sizeBytes(size: string): number {
  const [, digits, unit] = /^(\d+)([bkmg])?$/.exec(size)!;
  return Number(digits) * SIZE_UNITS[unit ?? "b"]!;
}

/** Unset, the agent size is at most the Workset size, so lowering that alone stays valid. */
function defaultAgentMemory(worksetMemory: string): string {
  return sizeBytes(worksetMemory) < sizeBytes(RUNNER_DEFAULTS.agentMemory)
    ? worksetMemory
    : RUNNER_DEFAULTS.agentMemory;
}

function dockerSize(setting: Setting, raw: unknown, fallback: string): string {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!/^[1-9]\d*[bkmg]?$/.test(value)) {
    throw new ConfigError(setting.env, String(raw).trim(), "must be a size such as 4g or 512m");
  }
  return value;
}

function positiveDecimal(setting: Setting, raw: unknown): string | null {
  const value = optionalText(raw);
  if (value === null) return null;
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new ConfigError(setting.env, value, "must be a number above 0, such as 2 or 1.5");
  }
  return value;
}

function token(setting: Setting, raw: unknown): string | null {
  const value = optionalText(raw);
  if (value === null) return null;
  if (value.length < MIN_TOKEN_LENGTH) {
    /** The value itself is never echoed. */
    throw new ConfigError(
      setting.env,
      "<hidden>",
      `must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  return value;
}

function hostList(setting: Setting, raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  const entries = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  const hosts = entries.map((entry) => entry.trim()).filter(Boolean);
  for (const host of hosts) {
    if (/[\s/?#@\\]/.test(host)) {
      throw new ConfigError(setting.env, host, "must list exact host[:port] values");
    }
  }
  return hosts;
}

function publicOrigin(setting: Setting, raw: unknown): string | null {
  const value = optionalText(raw);
  if (value === null) return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    /** Reported below. */
  }
  if (
    !parsed ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    value.endsWith("/")
  ) {
    throw new ConfigError(
      setting.env,
      value,
      "must be an exact origin such as https://studio.acme.test",
    );
  }
  return parsed.origin;
}

function credentials(setting: Setting, raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined || raw === "") return {};
  const result: Record<string, string> = {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      result[name] = String(value);
    }
    return result;
  }
  if (typeof raw !== "string") {
    throw new ConfigError(setting.env, String(raw), "must be a mapping of NAME to value");
  }
  for (const line of raw.split("\n")) {
    const value = line.trim();
    if (value === "" || value.startsWith("#")) continue;
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new ConfigError(setting.env, value, "must be NAME=value pairs, one per line");
    }
    result[value.slice(0, separator).trim()] = value.slice(separator + 1);
  }
  return result;
}

const REGISTRY_SCOPE = /^@[a-z0-9][a-z0-9._~-]*$/;

/** Validates `<scope>=<url>` plus its token; the token is never echoed. */
function pluginRegistry(
  registry: Setting,
  rawRegistry: unknown,
  tokenSetting: Setting,
  rawToken: unknown,
): PluginRegistry | null {
  const value = optionalText(rawRegistry);
  if (value === null) return null;
  const separator = value.indexOf("=");
  const scope = separator === -1 ? "" : value.slice(0, separator).trim();
  const registryUrl = separator === -1 ? "" : value.slice(separator + 1).trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(registryUrl);
  } catch {
    /** Reported below. */
  }
  if (
    !REGISTRY_SCOPE.test(scope) ||
    !parsed ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConfigError(
      registry.env,
      "<hidden>",
      "must be <scope>=<registry-url> with a URL free of credentials, such as @acme=https://registry.acme.test/api/npm/",
    );
  }
  const secret = optionalText(rawToken);
  if (secret === null || /\s/.test(secret)) {
    throw new ConfigError(
      tokenSetting.env,
      "<hidden>",
      `is required, without whitespace, when ${registry.env} is set`,
    );
  }
  return { scope, url: parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`, token: secret };
}

/** `https://host/acme/web.git` or `git@host:acme/web.git` → `acme/web`; null when none can be read. */
export function repositoryOfUrl(url: string): string | null {
  const trimmed = url
    .trim()
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  const pathPart = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, "")
    : (/^(?:[^/\s@]+@)?[^/\s:]{2,}:(.+)$/.exec(trimmed)?.[1] ?? "");
  const parts = pathPart.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : null;
}

function factoryRepositories(setting: Setting, raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  const entries = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[\n,]/);
  const urls = entries.map((entry) => entry.trim()).filter(Boolean);
  for (const url of urls) {
    if (repositoryOfUrl(url) === null) {
      throw new ConfigError(setting.env, url, "names no org/repository");
    }
  }
  return urls;
}

/** Exactly one of the two credentials, checked only in factory mode; values are never echoed. */
function factory(
  enabled: boolean,
  oauthToken: unknown,
  apiKey: unknown,
  repositories: string[],
  limits: FactoryRunner = RUNNER_DEFAULTS,
): FactoryConfig {
  if (!enabled) return { enabled, credential: null, repositories: [], ...limits };
  if (limits.maxBuilds > limits.maxRuns) {
    throw new ConfigError(
      "MATE_FACTORY_PARALLEL_BUILDS",
      String(limits.maxBuilds),
      `must not exceed MATE_FACTORY_PARALLEL_RUNS (${limits.maxRuns})`,
    );
  }
  if (sizeBytes(limits.agentMemory) > sizeBytes(limits.worksetMemory)) {
    throw new ConfigError(
      "MATE_FACTORY_AGENT_MEMORY",
      limits.agentMemory,
      `must not exceed MATE_FACTORY_WORKSET_MEMORY (${limits.worksetMemory})`,
    );
  }
  if (limits.maxRuns > limits.maxWorksets) {
    throw new ConfigError(
      "MATE_FACTORY_MAX_WORKSETS",
      String(limits.maxWorksets),
      `must be at least MATE_FACTORY_PARALLEL_RUNS (${limits.maxRuns}), or runs would wait for containers forever`,
    );
  }
  const subscription = optionalText(oauthToken);
  const key = optionalText(apiKey);
  if (subscription !== null && key !== null) {
    throw new ConfigError(
      "CLAUDE_CODE_OAUTH_TOKEN",
      "<hidden>",
      "and ANTHROPIC_API_KEY are both set; factory mode takes exactly one Workset agent credential",
    );
  }
  if (subscription !== null) {
    return {
      enabled,
      credential: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: subscription },
      repositories,
      ...limits,
    };
  }
  if (key !== null)
    return {
      enabled,
      credential: { name: "ANTHROPIC_API_KEY", value: key },
      repositories,
      ...limits,
    };
  return { enabled, credential: null, repositories, ...limits };
}

/** An address Git accepts: something at a domain, with no spaces or angle brackets. */
function gitEmail(raw: unknown): string {
  const value = optionalText(raw);
  if (value === null) return FACTORY_GIT_AUTHOR.email;
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(value)) {
    throw new ConfigError("MATE_FACTORY_GIT_EMAIL", value, "is not an email address");
  }
  return value;
}

function setting(env: string): Setting {
  const found = SETTINGS.find((candidate) => candidate.env === env);
  if (!found) throw new Error(`no such setting: ${env}`);
  return found;
}

/** `MATE_FACTORY_PARALLEL_RUNS`, or its older name; both set must agree. */
function parallelRuns(read: (name: string) => unknown): number {
  const current = positiveInteger(
    setting("MATE_FACTORY_PARALLEL_RUNS"),
    read("MATE_FACTORY_PARALLEL_RUNS"),
    0,
  );
  const older = positiveInteger(setting("MATE_FACTORY_MAX_RUNS"), read("MATE_FACTORY_MAX_RUNS"), 0);
  if (current && older && current !== older) {
    throw new ConfigError(
      "MATE_FACTORY_PARALLEL_RUNS",
      String(current),
      `disagrees with its older name MATE_FACTORY_MAX_RUNS (${older}); set one`,
    );
  }
  return current || older || RUNNER_DEFAULTS.maxRuns;
}

/** The runner limits, each setting read once, in the order their errors are reported. */
function factoryLimits(read: (name: string) => unknown): FactoryRunner {
  const maxRuns = parallelRuns(read);
  const maxBuilds = positiveInteger(
    setting("MATE_FACTORY_PARALLEL_BUILDS"),
    read("MATE_FACTORY_PARALLEL_BUILDS"),
    // Unset, at most the parallel runs, so a single-run factory needs no second setting.
    Math.min(RUNNER_DEFAULTS.maxBuilds, maxRuns),
  );
  const stageMinutes = positiveInteger(
    setting("MATE_FACTORY_STAGE_MINUTES"),
    read("MATE_FACTORY_STAGE_MINUTES"),
    RUNNER_DEFAULTS.stageMinutes,
  );
  const maxWorksets = positiveInteger(
    setting("MATE_FACTORY_MAX_WORKSETS"),
    read("MATE_FACTORY_MAX_WORKSETS"),
    maxRuns + 1,
  );
  const idleMinutes = nonNegativeInteger(
    setting("MATE_FACTORY_IDLE_MINUTES"),
    read("MATE_FACTORY_IDLE_MINUTES"),
    RUNNER_DEFAULTS.idleMinutes,
  );
  const worksetMemory = dockerSize(
    setting("MATE_FACTORY_WORKSET_MEMORY"),
    read("MATE_FACTORY_WORKSET_MEMORY"),
    RUNNER_DEFAULTS.worksetMemory,
  );
  return {
    maxRuns,
    maxBuilds,
    stageMinutes,
    maxWorksets,
    idleMinutes,
    worksetMemory,
    agentMemory: dockerSize(
      setting("MATE_FACTORY_AGENT_MEMORY"),
      read("MATE_FACTORY_AGENT_MEMORY"),
      defaultAgentMemory(worksetMemory),
    ),
    worksetPids: positiveInteger(
      setting("MATE_FACTORY_WORKSET_PIDS"),
      read("MATE_FACTORY_WORKSET_PIDS"),
      RUNNER_DEFAULTS.worksetPids,
    ),
    worksetCpus: positiveDecimal(
      setting("MATE_FACTORY_WORKSET_CPUS"),
      read("MATE_FACTORY_WORKSET_CPUS"),
    ),
    gitName: optionalText(read("MATE_FACTORY_GIT_NAME")) ?? FACTORY_GIT_AUTHOR.name,
    gitEmail: gitEmail(read("MATE_FACTORY_GIT_EMAIL")),
  };
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (file: string) => FileConfig = readConfigFile,
): ApplianceConfig {
  const configFile = env[CONFIG_FILE_ENV]?.trim() || DEFAULT_CONFIG_FILE;
  const file = readFile(configFile);

  const read = (name: string): unknown => rawValue(setting(name), env, file)?.value ?? null;
  const writable = bool(setting("MATE_STUDIO_WRITABLE"), read("MATE_STUDIO_WRITABLE"), true);

  return {
    companionsDir: text(read("MATE_COMPANIONS_DIR"), "/companions"),
    companionRepos: gitLocations(setting("MATE_COMPANION_REPOS"), read("MATE_COMPANION_REPOS")),
    companion: optionalText(read("MATE_COMPANION")),
    audience: audienceName(setting("MATE_AUDIENCE"), read("MATE_AUDIENCE")),
    studioPort: port(setting("MATE_STUDIO_PORT"), read("MATE_STUDIO_PORT"), 4097),
    studioHost: text(read("MATE_STUDIO_HOST"), "0.0.0.0"),
    studioWritable: writable,
    studioTerminal:
      writable && bool(setting("MATE_STUDIO_TERMINAL"), read("MATE_STUDIO_TERMINAL"), true),
    studioDetachMinutes: positiveInteger(
      setting("MATE_STUDIO_DETACH_MINUTES"),
      read("MATE_STUDIO_DETACH_MINUTES"),
      30,
    ),
    studioToken: token(setting("MATE_STUDIO_TOKEN"), read("MATE_STUDIO_TOKEN")),
    studioAllowedHosts: hostList(
      setting("MATE_STUDIO_ALLOWED_HOSTS"),
      read("MATE_STUDIO_ALLOWED_HOSTS"),
    ),
    studioPublicOrigin: publicOrigin(
      setting("MATE_STUDIO_PUBLIC_ORIGIN"),
      read("MATE_STUDIO_PUBLIC_ORIGIN"),
    ),
    gitSync: bool(setting("MATE_GIT_SYNC"), read("MATE_GIT_SYNC"), false),
    gitUserName: optionalText(read("MATE_GIT_USER_NAME")),
    gitUserEmail: optionalText(read("MATE_GIT_USER_EMAIL")),
    credentials: credentials(setting("MATE_AGENT_CREDENTIALS"), read("MATE_AGENT_CREDENTIALS")),
    pluginRegistry: pluginRegistry(
      setting("MATE_PLUGIN_REGISTRY"),
      read("MATE_PLUGIN_REGISTRY"),
      setting("MATE_PLUGIN_REGISTRY_TOKEN"),
      read("MATE_PLUGIN_REGISTRY_TOKEN"),
    ),
    gitCloneToken: optionalText(read("MATE_GIT_CLONE_TOKEN")),
    setupHint: optionalText(read("MATE_SETUP_HINT")),
    removed: REMOVED_SETTINGS.filter(
      (name) => env[name] !== undefined || file[REMOVED_KEYS[name]] !== undefined,
    ),
    factory: factory(
      bool(setting("MATE_FACTORY"), read("MATE_FACTORY"), false),
      read("CLAUDE_CODE_OAUTH_TOKEN"),
      read("ANTHROPIC_API_KEY"),
      factoryRepositories(setting("MATE_FACTORY_REPOSITORIES"), read("MATE_FACTORY_REPOSITORIES")),
      factoryLimits(read),
    ),
  };
}
