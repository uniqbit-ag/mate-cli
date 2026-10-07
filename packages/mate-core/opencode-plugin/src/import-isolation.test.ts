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

const IMPORT_PATTERN =
  /(?:import|export)[^"']*from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function listSourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listSourceFiles(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    )
    .filter((file) => /\.(ts|tsx)$/.test(file));
}

describe("OpenCode plugin import isolation", () => {
  test("reaches mate-core only through relative imports of the public plugin modules", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(PLUGIN_ROOT)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? match[2];
        if (!specifier) continue;
        const where = `${path.relative(PLUGIN_ROOT, file)}: ${specifier}`;
        /** A self-reference could resolve to another mate-core copy elsewhere in the tree. */
        if (specifier.startsWith("@uniqbit/mate-core")) {
          violations.push(where);
          continue;
        }
        if (!specifier.startsWith(".")) continue;
        const target = path.resolve(path.dirname(file), specifier);
        if (target.startsWith(PLUGIN_ROOT + path.sep)) continue;
        const allowed = ALLOWED_CORE_DIRECTORIES.some(
          (directory) => target === directory || target.startsWith(directory + path.sep),
        );
        if (!allowed) violations.push(where);
      }
    }
    expect(violations).toEqual([]);
  });
});
