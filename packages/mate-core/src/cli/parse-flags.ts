import {
  type GitModeSelection,
  listSetupCapabilityCompatibilities,
} from "../lib/orchestrator/setup-compatibilities";
import type { CapabilityConfig } from "../lib/orchestrator/types";

export type CliFlags = Record<string, string | string[] | boolean>;

/**
 * Flags whose presence is the whole value. A flag not listed here consumes the next
 * non-`--` token, so an unlisted boolean silently swallows a positional and then reads
 * as absent — e.g. `--no-push my-change` yielding `{"no-push": "my-change"}`.
 */
export type BooleanFlagSet = ReadonlySet<string>;

const NO_BOOLEAN_FLAGS: BooleanFlagSet = new Set<string>();

export function parseFlags(
  argv: string[],
  booleanFlags: BooleanFlagSet = NO_BOOLEAN_FLAGS,
): CliFlags {
  const flags: CliFlags = {};

  const assign = (key: string, value: string): void => {
    const current = flags[key];
    if (current === undefined) flags[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else flags[key] = [current as string, value];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      const key = body.slice(0, equals);
      const value = body.slice(equals + 1);
      if (booleanFlags.has(key)) flags[key] = value !== "false";
      else assign(key, value);
      continue;
    }

    if (booleanFlags.has(body)) {
      flags[body] = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[body] = true;
      continue;
    }

    assign(body, next);
    index += 1;
  }

  return flags;
}

/** Tokens that are neither flags nor flag values, read with the rules of {@link parseFlags}. */
export function positionalArgs(
  argv: string[],
  booleanFlags: BooleanFlagSet = NO_BOOLEAN_FLAGS,
): string[] {
  const names: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) names.push(token);
    else if (token.includes("=") || booleanFlags.has(token.slice(2))) continue;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) index += 1;
  }
  return names;
}

/** A flag's value when it was given one, so a bare or repeated flag reads as absent. */
export function stringFlag(value: CliFlags[string] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The first of `names` given bare or more than once, which {@link stringFlag} would read as absent. */
export function malformedValueFlag(flags: CliFlags, names: readonly string[]): string | undefined {
  return names.find((name) => flags[name] !== undefined && typeof flags[name] !== "string");
}

export function parseAllowedAgents(flags: CliFlags): string[] | undefined {
  const allowedAgents = flags["allowed-agent"];
  return Array.isArray(allowedAgents)
    ? allowedAgents
    : typeof allowedAgents === "string"
      ? [allowedAgents]
      : undefined;
}

export function parsePackageManagers(flags: CliFlags): string[] | undefined {
  const packageManager = flags["package-manager"];
  return Array.isArray(packageManager)
    ? packageManager
    : typeof packageManager === "string"
      ? [packageManager]
      : undefined;
}

export function parseCapabilities(flags: CliFlags): CapabilityConfig[] | undefined {
  const capability = flags["capability"];
  const names = Array.isArray(capability)
    ? capability
    : typeof capability === "string"
      ? [capability]
      : undefined;
  if (!names) return undefined;
  const index = new Map(
    listSetupCapabilityCompatibilities().map((e) => [e.capability.name, e.capability]),
  );
  return names.map((name) => index.get(name) ?? { name });
}

export function parseGitMode(flags: CliFlags): GitModeSelection | undefined {
  const gitMode = flags["git-mode"];
  if (gitMode === "auto" || gitMode === "default") return gitMode;
  return undefined;
}
