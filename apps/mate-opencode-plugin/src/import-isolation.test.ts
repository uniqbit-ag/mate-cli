import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const SRC_ROOT = import.meta.dirname;

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
  test("imports @uniqbit/mate-core only through the runtime and opencode subpaths", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? match[2];
        if (!specifier?.startsWith("@uniqbit/mate-core")) continue;
        if (
          specifier === "@uniqbit/mate-core/runtime" ||
          specifier === "@uniqbit/mate-core/opencode"
        ) {
          continue;
        }
        violations.push(`${path.relative(SRC_ROOT, file)}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
