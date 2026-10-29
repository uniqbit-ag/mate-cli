import fs from "node:fs";
import path from "node:path";

import { parse, stringify } from "yaml";

import { companionRegistryPath, globalConfigPath } from "../src/runtime/companion-registry-read";

function readYaml(file: string): Record<string, unknown> {
  try {
    return (parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function appendEntry(file: string, key: string, entry: object): void {
  const content = readYaml(file);
  const list = Array.isArray(content[key]) ? content[key] : [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify({ ...content, [key]: [...list, entry] }), "utf8");
}

/**
 * Makes a projection at `repoRoot` naming `companionPath` one Session
 * Resolution trusts, as `mate wrap` leaves it: the companion is registered in
 * the Mate configuration under `home` and its registry links `repositoryId`
 * at `repoRoot`. Returns the plain-session environment naming that home.
 */
export function trustProjection(options: {
  home: string;
  companionPath: string;
  repoRoot: string;
  repositoryId: string;
}): { HOME: string } {
  appendEntry(globalConfigPath(options.home), "companions", { path: options.companionPath });
  appendEntry(companionRegistryPath(options.companionPath), "repos", {
    id: options.repositoryId,
    path: options.repoRoot,
  });
  return { HOME: options.home };
}
