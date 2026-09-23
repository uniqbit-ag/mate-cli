import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { type ApplianceConfig, ConfigError, resolveConfig } from "./config";
import {
  assertCompanionsDirUsable,
  checkoutConfigured,
  discoverCompanions,
  type Runner,
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
 * the image; no package manager, resolver, download, native build, or
 * installation script runs anywhere in this path.
 *
 * The result is printed as a plan the shell supervisor reads, so the two
 * processes it starts are described in one place rather than assembled twice.
 */

export const PREBUILT_WORKSPACE_ENV = "MATE_PREBUILT_WORKSPACE";
export const DEFAULT_PREBUILT_WORKSPACE = "/opt/mate/prebuilt";

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

/**
 * Checks what the companion asks for against what the image carries, before
 * either serving process starts — so an unsatisfiable selection is a sentence
 * naming the requirement, rather than the installation gate refusing the
 * session with repair advice written for a human at a terminal.
 */
export function assertRequirementsCarried(
  selections: CompanionSelections,
  onPath: (command: string) => boolean = (command) => commandOnPath(command),
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
  for (const name of selections.capabilities) check("capability", name, SUPPORTED_CAPABILITIES);

  if (unsatisfied.length > 0) {
    throw new StartupError(
      `The selected companion declares requirements this image cannot satisfy:\n` +
        unsatisfied.map((entry) => `  - ${entry}`).join("\n") +
        `\nNothing was installed to repair this. Use an image that carries them, or change the companion's selections.`,
    );
  }
}

export interface StartupPlan {
  companion: string;
  companions: string[];
  agentPort: number;
  agentHost: string;
  studioPort: number;
  studioHost: string;
  studioWritable: boolean;
  gitSync: boolean;
}

export interface StartupDeps {
  run: Runner;
  mate: string;
  prebuilt: string;
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
    identity: defaultIdentity(),
    onPath: (command) => commandOnPath(command),
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

export function prepareStartup(
  config: ApplianceConfig,
  deps: StartupDeps = defaultDeps(),
): StartupPlan {
  assertCompanionsDirUsable(config.companionsDir, deps.identity);

  for (const outcome of checkoutConfigured(config.companionsDir, config.companionRepos, deps.run)) {
    deps.log(
      outcome.cloned
        ? `cloned ${outcome.location.url} into ${outcome.destination}`
        : `using the existing checkout at ${outcome.destination}`,
    );
  }

  const companions = discoverCompanions(config.companionsDir);

  // Registration is for Studio's inventory alone — the companion-scoped launch
  // resolves its own companion and never reads the registry.
  for (const companion of companions) {
    const result = deps.run(deps.mate, ["companion", "register", companion]);
    if (result.status !== 0) {
      throw new StartupError(
        `Registering ${companion} failed: ${(result.stderr || result.stdout).trim() || `mate exited ${result.status}`}`,
      );
    }
    deps.log(`registered ${companion}`);
  }

  const companion = selectCompanion(companions, config.companion);
  deps.log(`serving ${companion}`);

  assertRequirementsCarried(readCompanionSelections(companion), deps.onPath);

  // Filesystem-only: preparation validates the image's bundle and copies it.
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
        `${(prepared.stderr || prepared.stdout).trim() || `mate exited ${prepared.status}`}`,
    );
  }
  deps.log((prepared.stdout || prepared.stderr).trim() || `prepared ${companion}`);

  return {
    companion,
    companions,
    agentPort: config.agentPort,
    agentHost: config.agentHost,
    studioPort: config.studioPort,
    studioHost: config.studioHost,
    studioWritable: config.studioWritable,
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
    `MATE_PLAN_AGENT_PORT=${shellQuote(String(plan.agentPort))}`,
    `MATE_PLAN_AGENT_HOST=${shellQuote(plan.agentHost)}`,
    `MATE_PLAN_STUDIO_PORT=${shellQuote(String(plan.studioPort))}`,
    `MATE_PLAN_STUDIO_HOST=${shellQuote(plan.studioHost)}`,
    `MATE_PLAN_STUDIO_WRITABLE=${shellQuote(plan.studioWritable ? "1" : "")}`,
    `MATE_PLAN_GIT_SYNC=${shellQuote(plan.gitSync ? "1" : "")}`,
  ].join("\n");
}

/**
 * Credentials are printed separately and never written to disk: the supervisor
 * evaluates them straight into the session's environment, so they reach the
 * agent and nothing else. They are not part of the plan, and no Companion
 * Repository ever sees them.
 */
export function renderCredentials(config: ApplianceConfig): string {
  const lines = Object.entries(config.credentials).map(
    ([name, value]) => `export ${name}=${shellQuote(value)}`,
  );
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
