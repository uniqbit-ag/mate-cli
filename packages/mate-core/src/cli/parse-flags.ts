import {
  type GitModeSelection,
  type OpenSpecSchemaSelection,
  listSetupCapabilityCompatibilities,
} from "../lib/orchestrator/setup-compatibilities";
import type { CapabilityConfig } from "../lib/orchestrator/types";

export type CliFlags = Record<string, string | string[] | boolean>;

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    if (flags[key] === undefined) {
      flags[key] = next;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(next);
    } else {
      flags[key] = [flags[key] as string, next];
    }

    index += 1;
  }

  return flags;
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

export function parseOpenSpecSchema(flags: CliFlags): OpenSpecSchemaSelection | undefined {
  const schema = flags["openspec-schema"];
  if (schema === "mate-v1" || schema === "default") return schema;
  return undefined;
}

export function parseGitMode(flags: CliFlags): GitModeSelection | undefined {
  const gitMode = flags["git-mode"];
  if (gitMode === "auto" || gitMode === "default") return gitMode;
  return undefined;
}
