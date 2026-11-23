import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");
const CORE_SRC = path.resolve(PLUGIN_ROOT, "..", "src");

/**
 * The session-runtime modules; anything else in mate-core is off limits to the plugin.
 * Only the TUI entry may reach the TUI module, which `server-isolation` keeps off the server path.
 */
const ALLOWED_CORE_DIRECTORIES = ["runtime", "opencode"].map((entry) => path.join(CORE_SRC, entry));
/** Import-free leaves outside those directories; the TUI's version line takes the brand accent. */
const ALLOWED_CORE_FILES = [path.join(CORE_SRC, "brand", "palette.ts")];

const IMPORT_PATTERN =
  /(?:import|export)[^"']*from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function listSourceFiles(dir: string): string[] {
  return (
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? listSourceFiles(path.join(dir, entry.name))
          : [path.join(dir, entry.name)],
      )
      /** Package files exclude tests; only the shipped runtime has this import boundary. */
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".test.ts"))
  );
}

function resolveModule(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isAllowedCore(file: string): boolean {
  if (ALLOWED_CORE_FILES.includes(file)) return true;
  return ALLOWED_CORE_DIRECTORIES.some(
    (directory) => file === directory || file.startsWith(directory + path.sep),
  );
}

/** Follows relative imports from `entry` through mate-core; returns each violation with its import chain. */
function violationsFrom(entry: string): string[] {
  const violations: string[] = [];
  const chains = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const chain = chains.get(file)!;
    const show = (specifier: string) =>
      [...chain.map((link) => path.relative(PLUGIN_ROOT, link)), specifier].join(" -> ");
    for (const match of fs.readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      /** A self-reference could resolve to another mate-core copy elsewhere in the tree. */
      if (specifier.startsWith("@uniqbit/mate-core")) {
        violations.push(show(specifier));
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolveModule(file, specifier) ?? path.resolve(path.dirname(file), specifier);
      const inPlugin = target.startsWith(PLUGIN_ROOT + path.sep);
      if (!inPlugin && !isAllowedCore(target)) {
        violations.push(show(path.relative(PLUGIN_ROOT, target)));
        continue;
      }
      if (chains.has(target) || !fs.existsSync(target)) continue;
      /** Plugin files are entries of their own; only mate-core is followed. */
      if (inPlugin) continue;
      chains.set(target, [...chain, target]);
      queue.push(target);
    }
  }
  return violations;
}

describe("OpenCode plugin import isolation", () => {
  test("reaches mate-core only through the session-runtime modules, transitively", () => {
    const violations = new Set<string>();
    for (const file of listSourceFiles(PLUGIN_ROOT)) {
      for (const violation of violationsFrom(file)) violations.add(violation);
    }
    expect([...violations]).toEqual([]);
  });
});
