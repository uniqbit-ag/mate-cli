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

let heldNotices: string[] | undefined;

/** Writes a tool notice to stderr, or holds it while {@link holdToolNotices} is in effect. */
export function toolNotice(line: string): void {
  if (heldNotices) heldNotices.push(line);
  else process.stderr.write(line);
}

/**
 * Holds tool notices until the returned function runs: a write under a live Ink view
 * garbles its frames. Call that function once the view is unmounted.
 */
export function holdToolNotices(): () => void {
  heldNotices ??= [];
  return () => {
    const lines = heldNotices ?? [];
    heldNotices = undefined;
    for (const line of lines) process.stderr.write(line);
  };
}

/**
 * Warns when a readable installed version differs from the pin, older or newer:
 * Mate reviewed only the pinned one. Never throws (install-contract `update`).
 * `binary` is the installed file: the warning names it, because `command` may install elsewhere.
 */
export function warnOnVersionDrift(
  tool: string,
  installed: string | null | undefined,
  command: string,
  binary?: string | null,
): void {
  const parsed = installed
    ? semver.valid(semver.coerce(installed, { includePrerelease: true }))
    : null;
  const pinned = toolVersion(tool);
  if (!parsed || parsed === pinned) return;
  toolNotice(
    `${tool} ${parsed} is installed${binary ? ` at ${binary}` : ""}; Mate ${mateVersion()} pins ${pinned}. Install it with: ${command}\n` +
      (binary
        ? `  The first ${tool} on PATH wins: if the pinned one installs elsewhere, remove ${binary} or put the new directory first.\n`
        : ""),
  );
}
