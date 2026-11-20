import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The factory is a service plugin: core reaches it only through the service contract, and a
 * distribution registers it through `@uniqbit/mate-core/factory`. Nothing else in core may
 * import its modules, so moving it into its own package needs no core change.
 */

const SRC = import.meta.dir;

/** The factory's own code; it moves as a whole. */
const FACTORY_OWNED = [
  path.join(SRC, "lib", "factory"),
  path.join(SRC, "cli", "commands", "factory"),
];

const owned = (file: string) => FACTORY_OWNED.some((dir) => file.startsWith(`${dir}${path.sep}`));

/** Static, re-export and dynamic import specifiers of a module. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm,
  )) {
    found.push(match[1]!);
  }
  return found;
}

/** The factory modules `file` imports, as paths relative to `src`. */
function factoryImports(file: string, source: string): string[] {
  return specifiers(source)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => path.resolve(path.dirname(file), specifier))
    .filter((target) =>
      FACTORY_OWNED.some((dir) => target === dir || target.startsWith(`${dir}${path.sep}`)),
    )
    .map((target) => path.relative(SRC, target));
}

async function sources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // oxlint-disable-next-line no-await-in-loop -- a bounded tree walk
    if (entry.isDirectory()) files.push(...(await sources(full)));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("core reaches the factory only through the service contract", () => {
  it("finds each import form it guards against", () => {
    const file = path.join(SRC, "cli", "commands", "studio", "server.ts");
    expect(
      factoryImports(
        file,
        [
          'import { factoryClient } from "../../../lib/factory/client";',
          'export type { FactoryRunView } from "../../../lib/factory/outcomes/runs";',
          'const { serveBroker } = await import("../../../lib/factory/broker");',
          'import { runFactoryCommand } from "../factory/factory";',
          'import { WorksetError } from "../../../lib/workset/record";',
        ].join("\n"),
      ),
    ).toEqual([
      path.join("lib", "factory", "client"),
      path.join("lib", "factory", "outcomes", "runs"),
      path.join("lib", "factory", "broker"),
      path.join("cli", "commands", "factory", "factory"),
    ]);
  });

  it("no core module outside the factory imports it", async () => {
    const files = (await sources(SRC)).filter((file) => !owned(file));
    expect(files.length).toBeGreaterThan(100);
    const offenders: { file: string; imports: string[] }[] = [];
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time keeps the walk small
      const imports = factoryImports(file, await fs.readFile(file, "utf8"));
      if (imports.length > 0) offenders.push({ file: path.relative(SRC, file), imports });
    }
    expect(offenders).toEqual([]);
  });

  it("the package exposes the factory only through its own entries", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(SRC, "..", "package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    const reaching = Object.entries(manifest.exports)
      .filter(([, target]) => target.includes("/factory/"))
      .map(([entry]) => entry);
    expect(reaching.toSorted()).toEqual(["./factory", "./factory-studio"]);
  });
});
