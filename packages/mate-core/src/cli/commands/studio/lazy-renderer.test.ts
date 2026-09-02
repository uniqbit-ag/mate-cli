import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const PACKAGE_SRC = path.resolve(import.meta.dir, "../../..");
const CLI_ENTRY = path.join(PACKAGE_SRC, "index.ts");
const STUDIO_ENTRY = path.join(import.meta.dir, "index.ts");
const RENDERER = path.join(import.meta.dir, "views", "document.tsx");

/** Type-only edges are erased, so they are not module loads. */
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)(?!\s+type\b)[\s\S]*?from\s+"([^"]+)"/g;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s+"([^"]+)"/g;
const JSX_PRAGMA = /@jsxImportSource\s+(\S+)/;
const DYNAMIC_IMPORT = /\bimport\(\s*"([^"]+)"\s*\)/g;

async function resolve(fromFile: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

/** Every module reachable from an entry through static import edges only. */
async function staticGraph(entry: string): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file)) continue;
    const source = await fs.readFile(file, "utf8");
    const pragma = source.match(JSX_PRAGMA)?.[1];
    const specifiers = [
      ...(pragma ? [`${pragma}/jsx-runtime`] : []),
      ...[...source.matchAll(STATIC_IMPORT)].map((match) => match[1]!),
      ...[...source.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[1]!),
    ];
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      const resolved = await resolve(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }

  return graph;
}

describe("the renderer is loaded on the studio path alone", () => {
  test("importing the CLI entry pulls in no hono module", async () => {
    const graph = await staticGraph(CLI_ENTRY);

    expect(graph.size).toBeGreaterThan(50);
    const offenders = [...graph]
      .filter(([, specifiers]) => specifiers.some((entry) => entry.startsWith("hono")))
      .map(([file]) => path.relative(PACKAGE_SRC, file));
    expect(offenders).toEqual([]);
  });

  test("importing the CLI entry does not reach the studio views", async () => {
    const graph = await staticGraph(CLI_ENTRY);

    expect(graph.has(STUDIO_ENTRY)).toBe(true);
    expect(
      [...graph.keys()].filter((file) => file.includes(`${path.sep}views${path.sep}`)),
    ).toEqual([]);
  });

  test("the studio server reaches the renderer through a dynamic import", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "server.ts"), "utf8");
    const dynamic = [...source.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]!);

    expect(dynamic).toContain("./views/document");
    expect(await resolve(path.join(import.meta.dir, "server.ts"), "./views/document")).toBe(
      RENDERER,
    );
  });

  test("the renderer still renders when it is loaded", async () => {
    const views = await import("./views/document");

    expect(
      views.renderStudioDocument({
        inventory: { companions: [] },
        selection: { companionDigest: null, view: "dashboard" },
        companion: null,
        payload: null,
        error: null,
      }),
    ).toContain("<!doctype html>");
  });
});
