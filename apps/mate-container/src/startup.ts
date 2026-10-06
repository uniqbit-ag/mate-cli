import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { type ApplianceConfig, ConfigError, type PluginRegistry, resolveConfig } from "./config";
import {
  assertCompanionsDirUsable,
  checkoutConfigured,
  discoverCompanions,
  redact,
  type Runner,
  type RunResult,
  runCommand,
  selectCompanion,
  StartupError,
} from "./discovery";

/**
 * Everything the container does before either serving process starts.
 *
 * It registers, it does not set up: registration exists so Studio's inventory
 * lists the companion, and nothing here decides a selection for a companion
 * someone else configured. Dependency preparation copies installed files from
 * the image. Without a configured plugin registry no package manager,
 * resolver, download, native build, or installation script runs anywhere in
 * this path; with one, the selected companion's frozen restore runs first.
 *
 * The result is printed as a plan the shell supervisor reads, so the two
 * processes it starts are described in one place rather than assembled twice.
 */

export const PREBUILT_WORKSPACE_ENV = "MATE_PREBUILT_WORKSPACE";
export const DEFAULT_PREBUILT_WORKSPACE = "/opt/mate/prebuilt";
export const SETUP_SCRIPT_ENV = "MATE_SETUP_SCRIPT";
export const DEFAULT_SETUP_SCRIPT = "/opt/mate/tools/startup/setup.sh";

/**
 * What a companion can select, and the command the image must carry for it.
 * A selection absent from this map is outside the release's supported set:
 * reported by name rather than installed.
 */
export const SUPPORTED_PACKAGE_MANAGERS: Record<string, string | null> = {
  bun: "bun",
  uv: "uv",
};

export const SUPPORTED_CAPABILITIES: Record<string, string | null> = {
  openspec: "openspec",
  graphify: "graphify",
  rtk: "rtk",
  tokensave: "tokensave",
  context7: "context7-mcp",
  // Carried as installed packages in the prebuilt workspace rather than as a
  // command on PATH.
  "context-mode": null,
  "react-doctor": null,
};

export interface CompanionSelections {
  packageManagers: string[];
  capabilities: string[];
}

export function readCompanionSelections(companionPath: string): CompanionSelections {
  const file = path.join(companionPath, ".mate", "config", "framework.yaml");
  let parsed: unknown;
  try {
    parsed = parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new StartupError(`${file} could not be read: ${(error as Error).message}`);
  }
  const config = (parsed ?? {}) as {
    packageManagers?: unknown;
    capabilities?: unknown;
  };
  const packageManagers = Array.isArray(config.packageManagers)
    ? config.packageManagers.map((entry) => String(entry))
    : ["bun"];
  const capabilities = Array.isArray(config.capabilities)
    ? config.capabilities.map((entry) =>
        typeof entry === "string" ? entry : String((entry as { name?: unknown })?.name ?? ""),
      )
    : [];
  return { packageManagers, capabilities: capabilities.filter((name) => name !== "") };
}

export function commandOnPath(
  command: string,
  pathValue: string = process.env.PATH ?? "",
): boolean {
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // Keep looking; an unreadable directory on PATH is not an answer.
    }
  }
  return false;
}

/** Fails with a sentence naming each requirement the image cannot satisfy. */
export function assertRequirementsCarried(
  selections: CompanionSelections,
  onPath: (command: string) => boolean = (command) => commandOnPath(command),
  pluginCapabilities: readonly string[] = [],
): void {
  const unsatisfied: string[] = [];

  const check = (kind: string, name: string, supported: Record<string, string | null>) => {
    if (!(name in supported)) {
      unsatisfied.push(`${kind} "${name}": this image does not carry it`);
      return;
    }
    const command = supported[name];
    if (command !== null && !onPath(command)) {
      unsatisfied.push(
        `${kind} "${name}": the command \`${command}\` is not present in this image`,
      );
    }
  };

  for (const name of selections.packageManagers)
    check("package manager", name, SUPPORTED_PACKAGE_MANAGERS);
  /**
   * A capability the image does not know passes only when a strictly
   * verified plugin reports providing that exact ID; a plugin's package name
   * or an unrelated declaration never stands in for it.
   */
  for (const name of selections.capabilities) {
    if (!(name in SUPPORTED_CAPABILITIES) && pluginCapabilities.includes(name)) continue;
    check("capability", name, SUPPORTED_CAPABILITIES);
  }

  if (unsatisfied.length > 0) {
    throw new StartupError(
      `The selected companion declares requirements this image cannot satisfy:\n` +
        unsatisfied.map((entry) => `  - ${entry}`).join("\n") +
        `\nNothing was installed to repair this. Use an image that carries them, or change the companion's selections.`,
    );
  }
}

/** Reads `mate doctor --json`'s `pluginCapabilities`; anything unreadable provides nothing. */
export function parsePluginCapabilities(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { pluginCapabilities?: unknown };
    return Array.isArray(parsed.pluginCapabilities)
      ? parsed.pluginCapabilities.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

export interface StartupPlan {
  companion: string;
  companions: string[];
  studioPort: number;
  studioHost: string;
  studioWritable: boolean;
  studioTerminal: boolean;
  studioDetachMinutes: number;
  studioAllowedHosts: string[];
  studioPublicOrigin: string | null;
  gitSync: boolean;
}

export interface StartupDeps {
  run: Runner;
  mate: string;
  prebuilt: string;
  setupScript: string;
  identity: string;
  onPath: (command: string) => boolean;
  log: (line: string) => void;
}

function defaultIdentity(): string {
  const id = typeof os.userInfo === "function" ? os.userInfo() : null;
  return id ? `${id.username} (uid ${id.uid})` : `uid ${process.getuid?.() ?? "unknown"}`;
}

export function defaultDeps(): StartupDeps {
  return {
    run: runCommand,
    mate: "mate",
    prebuilt: process.env[PREBUILT_WORKSPACE_ENV]?.trim() || DEFAULT_PREBUILT_WORKSPACE,
    setupScript: process.env[SETUP_SCRIPT_ENV]?.trim() || DEFAULT_SETUP_SCRIPT,
    identity: defaultIdentity(),
    onPath: (command) => commandOnPath(command),
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

/** Child output as printed: trimmed, startup-only tokens masked, `fallback` when empty. */
function childDetail(result: RunResult, fallback: string, secrets: Array<string | null>): string {
  return redact((result.stderr || result.stdout).trim(), ...secrets) || fallback;
}

/**
 * npm reads the project `.npmrc` beside `.mate/plugins/package.json`, so only
 * that file can redirect the registry or carry credentials for it.
 */
function overridesRegistry(npmrc: string, registry: PluginRegistry): boolean {
  if (/registry/i.test(npmrc)) return true;
  const host = new URL(registry.url).host;
  return npmrc
    .split("\n")
    .some((line) => /^\s*\/\/.*:_auth(Token)?\s*=/.test(line) && line.includes(host));
}

/** Frozen restore of the companion's locked plugins through the image-owned setup script. */
function restorePlugins(
  registry: PluginRegistry,
  companion: string,
  deps: StartupDeps,
  secrets: Array<string | null>,
): void {
  const override = path.join(companion, ".mate", "plugins", ".npmrc");
  if (fs.existsSync(override) && overridesRegistry(fs.readFileSync(override, "utf8"), registry)) {
    throw new StartupError(
      `${override} overrides the configured plugin registry; remove it from the companion.`,
    );
  }
  deps.log(`restoring plugins of ${companion} from ${registry.url}`);
  const restored = deps.run("bash", [deps.setupScript, companion], companion, {
    MATE_PLUGIN_REGISTRY_SCOPE: registry.scope,
    MATE_PLUGIN_REGISTRY_URL: registry.url,
    MATE_PLUGIN_REGISTRY_TOKEN: registry.token,
  });
  if (restored.status !== 0) {
    throw new StartupError(
      `Restoring the plugins of ${companion} failed:\n${childDetail(restored, `setup exited ${restored.status}`, secrets)}`,
    );
  }
}

/** Why each removed setting is ignored. */
const REMOVED_SETTING_NOTES: Record<string, string> = {
  MATE_ALLOWED_PLUGINS:
    "the selected companion's plugin declarations are authoritative, so restrict who can change them",
};
const DEFAULT_REMOVED_NOTE = "the container serves Studio alone and agents start from its terminal";

export function prepareStartup(
  config: ApplianceConfig,
  deps: StartupDeps = defaultDeps(),
): StartupPlan {
  const secrets = [config.pluginRegistry?.token ?? null, config.gitCloneToken];
  for (const name of config.removed) {
    deps.log(
      `warning: ${name} is no longer used; ${REMOVED_SETTING_NOTES[name] ?? DEFAULT_REMOVED_NOTE}`,
    );
  }
  assertCompanionsDirUsable(config.companionsDir, deps.identity);

  for (const outcome of checkoutConfigured(
    config.companionsDir,
    config.companionRepos,
    deps.run,
    config.gitCloneToken,
    config.pluginRegistry?.token ?? null,
  )) {
    deps.log(
      outcome.cloned
        ? `cloned ${outcome.location.url} into ${outcome.destination}`
        : `using the existing checkout at ${outcome.destination}`,
    );
  }

  const companions = discoverCompanions(config.companionsDir);

  /** Registration feeds Studio's inventory and validates its pinned launch companion. */
  for (const companion of companions) {
    const result = deps.run(deps.mate, ["companion", "register", companion]);
    if (result.status !== 0) {
      throw new StartupError(
        `Registering ${companion} failed: ${childDetail(result, `mate exited ${result.status}`, secrets)}`,
      );
    }
    deps.log(`registered ${companion}`);
  }

  const companion = selectCompanion(companions, config.companion, config.setupHint);
  deps.log(`serving ${companion}`);

  if (config.pluginRegistry !== null)
    restorePlugins(config.pluginRegistry, companion, deps, secrets);

  /** Runs before the requirement check: verified plugins' capabilities feed it. */
  const verifyResult = deps.run(deps.mate, ["doctor", "--json"], companion);
  if (verifyResult.status !== 0) {
    throw new StartupError(
      `The declared plugins of ${companion} are not ready:\n` +
        `${childDetail(verifyResult, `mate exited ${verifyResult.status}`, secrets)}\n` +
        `Nothing was installed to repair this. ${
          config.pluginRegistry === null
            ? "Configure MATE_PLUGIN_REGISTRY to restore them at startup, or change the credentials."
            : "Check the companion's plugin declarations, lockfile and credentials."
        }`,
    );
  }
  const pluginCapabilities = parsePluginCapabilities(verifyResult.stdout);

  assertRequirementsCarried(readCompanionSelections(companion), deps.onPath, pluginCapabilities);

  const prepared = deps.run(deps.mate, [
    "companion",
    "prepare",
    "--from",
    deps.prebuilt,
    companion,
  ]);
  if (prepared.status !== 0) {
    throw new StartupError(
      `Preparing the machine-local dependencies of ${companion} from ${deps.prebuilt} failed:\n` +
        childDetail(prepared, `mate exited ${prepared.status}`, secrets),
    );
  }
  deps.log((prepared.stdout || prepared.stderr).trim() || `prepared ${companion}`);

  return {
    companion,
    companions,
    studioPort: config.studioPort,
    studioHost: config.studioHost,
    studioWritable: config.studioWritable,
    studioTerminal: config.studioTerminal,
    studioDetachMinutes: config.studioDetachMinutes,
    studioAllowedHosts: config.studioAllowedHosts,
    studioPublicOrigin: config.studioPublicOrigin,
    gitSync: config.gitSync,
  };
}

/** Shell-safe single-quoting, for the lines the supervisor evaluates. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderPlan(plan: StartupPlan): string {
  return [
    `MATE_PLAN_COMPANION=${shellQuote(plan.companion)}`,
    `MATE_PLAN_STUDIO_PORT=${shellQuote(String(plan.studioPort))}`,
    `MATE_PLAN_STUDIO_HOST=${shellQuote(plan.studioHost)}`,
    `MATE_PLAN_STUDIO_WRITABLE=${shellQuote(plan.studioWritable ? "1" : "")}`,
    `MATE_PLAN_STUDIO_TERMINAL=${shellQuote(plan.studioTerminal ? "1" : "")}`,
    `MATE_PLAN_STUDIO_DETACH_MINUTES=${shellQuote(String(plan.studioDetachMinutes))}`,
    `MATE_PLAN_STUDIO_ALLOWED_HOSTS=${shellQuote(plan.studioAllowedHosts.join(","))}`,
    `MATE_PLAN_STUDIO_PUBLIC_ORIGIN=${shellQuote(plan.studioPublicOrigin ?? "")}`,
    `MATE_PLAN_GIT_SYNC=${shellQuote(plan.gitSync ? "1" : "")}`,
  ].join("\n");
}

/**
 * Credentials are printed separately and never written to disk: the supervisor
 * evaluates them straight into Studio's environment, which agent sessions
 * inherit. Studio's pinned token travels the same way rather than as an
 * argument a process listing would show; Studio strips it from each launch.
 * Startup-only tokens are deliberately absent.
 */
export function renderCredentials(config: ApplianceConfig): string {
  const lines = Object.entries(config.credentials).map(
    ([name, value]) => `export ${name}=${shellQuote(value)}`,
  );
  if (config.studioToken !== null) {
    lines.push(`export MATE_STUDIO_TOKEN=${shellQuote(config.studioToken)}`);
  }
  if (config.gitUserName !== null) {
    lines.push(`export GIT_AUTHOR_NAME=${shellQuote(config.gitUserName)}`);
    lines.push(`export GIT_COMMITTER_NAME=${shellQuote(config.gitUserName)}`);
  }
  if (config.gitUserEmail !== null) {
    lines.push(`export GIT_AUTHOR_EMAIL=${shellQuote(config.gitUserEmail)}`);
    lines.push(`export GIT_COMMITTER_EMAIL=${shellQuote(config.gitUserEmail)}`);
  }
  return lines.join("\n");
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let config: ApplianceConfig;
  try {
    config = resolveConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`mate-appliance: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  try {
    if (argv.includes("--credentials")) {
      process.stdout.write(`${renderCredentials(config)}\n`);
      return 0;
    }
    process.stdout.write(`${renderPlan(prepareStartup(config))}\n`);
    return 0;
  } catch (error) {
    if (error instanceof StartupError || error instanceof ConfigError) {
      process.stderr.write(`mate-appliance: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exit(main());
}
