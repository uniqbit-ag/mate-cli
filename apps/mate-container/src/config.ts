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

function setting(env: string): Setting {
  const found = SETTINGS.find((candidate) => candidate.env === env);
  if (!found) throw new Error(`no such setting: ${env}`);
  return found;
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
  };
}
