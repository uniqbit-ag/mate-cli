import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const SRC_ROOT = path.resolve(import.meta.dirname, "..");

const IMPORT_PATTERN =
  /(?:import|export)[^"']*from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function collectTransitiveModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const resolved = resolveModule(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return seen;
}

function relative(files: Iterable<string>): string[] {
  return [...files].map((file) => path.relative(SRC_ROOT, file));
}

describe("runtime subpath import isolation", () => {
  test("./runtime modules never import the rest of core", () => {
    const modules = collectTransitiveModules(path.join(SRC_ROOT, "runtime", "index.ts"));
    const outside = relative(modules).filter((file) => !file.startsWith("runtime/"));
    expect(outside).toEqual([]);
  });

  test("./opencode modules stay on the session-runtime side of core", () => {
    const modules = collectTransitiveModules(path.join(SRC_ROOT, "opencode", "index.ts"));
    const outside = relative(modules).filter(
      (file) => !file.startsWith("opencode/") && !file.startsWith("runtime/"),
    );
    expect(outside).toEqual([]);
  });
});
