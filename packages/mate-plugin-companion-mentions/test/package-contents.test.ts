import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";

const packageRoot = path.resolve(import.meta.dir, "..");

/** The files `npm pack` would publish, relative to the package root. */
function packedFiles(): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--loglevel", "error"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);
  const [packed] = JSON.parse(result.stdout) as [{ files: { path: string }[] }];
  return packed.files.map((file) => file.path).toSorted();
}

/**
 * Packs once, with a stand-in for the types Claude writes beside the mod on
 * first load when none are there yet, so their exclusion is tested too.
 */
let files: string[] = [];
beforeAll(() => {
  const types = path.join(packageRoot, "claude-plugin", ".claude-plugin", "types");
  const created = !fs.existsSync(types);
  if (created) {
    fs.mkdirSync(types);
    fs.writeFileSync(path.join(types, "claude-code.d.ts"), "export {};\n");
  }
  try {
    files = packedFiles();
  } finally {
    if (created) fs.rmSync(types, { recursive: true, force: true });
  }
}, 60_000);

describe("the published package", () => {
  test("holds the factory, the mod's manifest and hook modules, and the README", () => {
    for (const file of [
      "package.json",
      "README.md",
      "src/index.ts",
      "claude-plugin/.claude-plugin/plugin.json",
      "claude-plugin/hooks/hooks.json",
      "claude-plugin/hooks/register.ts",
      "claude-plugin/hooks/companion.ts",
    ]) {
      expect(files).toContain(file);
    }
  });

  test("holds no tests, test helpers, or the types Claude Code writes beside the mod", () => {
    const unexpected = files.filter(
      (file) =>
        file.endsWith(".test.ts") ||
        file.startsWith("claude-plugin/tests/") ||
        file.startsWith("claude-plugin/.claude-plugin/types/") ||
        file === "claude-plugin/tsconfig.json" ||
        file.startsWith("test/") ||
        file === "bunfig.toml",
    );
    expect(unexpected).toEqual([]);
  });
});
