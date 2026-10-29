import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";

const packageRoot = path.resolve(import.meta.dir, "../../../..");
const MOD = "claude-capability-plugins/companion-mentions";
const modRoot = path.join(packageRoot, MOD);

/** The files `npm pack` would publish, relative to mate-core's root. */
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
  const types = path.join(modRoot, ".claude-plugin", "types");
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

describe("the published mate-core", () => {
  test("holds the mod's manifest, marketplace file and hook modules", () => {
    for (const file of [
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "hooks/hooks.json",
      "hooks/register.ts",
      "hooks/companion.ts",
    ]) {
      expect(files).toContain(`${MOD}/${file}`);
    }
  });

  test("holds none of the mod's tests, its tsconfig, or the types Claude Code writes beside it", () => {
    const unexpected = files.filter(
      (file) =>
        file.startsWith(`${MOD}/tests/`) ||
        file.startsWith(`${MOD}/.claude-plugin/types/`) ||
        file === `${MOD}/tsconfig.json`,
    );
    expect(unexpected).toEqual([]);
  });
});

const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(modRoot, ".claude-plugin", file), "utf8"));

/** Claude Code's marketplace name rules, as Mate checks them before publishing a folder. */
const RESERVED_MARKETPLACE_NAMES = [
  "claude-plugins-official",
  "inline",
  "builtin",
  "skills-dir",
  "synced",
  "github",
  "npm",
];

describe("the mod's marketplace file", () => {
  const marketplace = readJson("marketplace.json");
  const manifest = readJson("plugin.json");

  test("has a valid, unreserved name that is not in Mate's own form", () => {
    expect(marketplace.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(RESERVED_MARKETPLACE_NAMES).not.toContain(marketplace.name);
    expect(marketplace.name.startsWith("claudeai-")).toBe(false);
    expect(marketplace.owner.name).not.toBe("Mate");
    expect(marketplace.name.startsWith("mate-plugin-")).toBe(false);
  });

  test("lists one plugin, the manifest's, in place", () => {
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe(manifest.name);
    expect(marketplace.plugins[0].source).toBe("./");
    expect(marketplace.plugins[0].version).toBeUndefined();
  });

  test("leaves the version to the manifest, which declares mate-core's", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    expect(manifest.version).toBe(pkg.version);
  });
});
