import fs from "node:fs";
import path from "node:path";

import semver from "semver";
import { parse } from "yaml";

import { mateVersion } from "../runtime/install";

const TOOL_MANIFEST_FILE = path.resolve(import.meta.dirname, "../../tool-manifest.yaml");

interface ToolManifest {
  schema: number;
  tools: Record<string, { version: string } & Record<string, unknown>>;
}

let cached: ToolManifest | undefined;

export function readToolManifest(): ToolManifest {
  cached ??= parse(fs.readFileSync(TOOL_MANIFEST_FILE, "utf8")) as ToolManifest;
  return cached;
}

/** The exact version Mate pins for `name`; throws for a tool the manifest does not name. */
export function toolVersion(name: string): string {
  const version = readToolManifest().tools?.[name]?.version;
  if (!version) throw new Error(`tool manifest names no version for ${name}`);
  return version;
}

/**
 * Warns when a readable installed version differs from the pin, older or newer:
 * Mate reviewed only the pinned one. Never throws (install-contract `update`).
 */
export function warnOnVersionDrift(
  tool: string,
  installed: string | null | undefined,
  command: string,
): void {
  const parsed = installed
    ? semver.valid(semver.coerce(installed, { includePrerelease: true }))
    : null;
  const pinned = toolVersion(tool);
  if (!parsed || parsed === pinned) return;
  process.stderr.write(
    `${tool} ${parsed} is installed; Mate ${mateVersion()} pins ${pinned}. Install it with: ${command}\n`,
  );
}
