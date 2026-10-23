import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import { SUPPORTED_PLUGIN_API_VERSIONS } from "@uniqbit/mate-core";

const packageRoot = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A plugin workspace with this package installed, as `mate install` lays it out. */
function pluginWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-mentions-workspace-"));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{ "private": true }\n');
  const installed = path.join(root, "node_modules", ...manifest.name.split("/"));
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.symlinkSync(packageRoot, installed, "dir");
  return root;
}

describe("loader contract", () => {
  test("declares a Plugin API version mate-core supports", () => {
    expect(SUPPORTED_PLUGIN_API_VERSIONS).toContain(manifest.mate.pluginApiVersion);
  });

  test("resolves through the workspace's own require, and exports the factory by default", async () => {
    const workspaceRequire = createRequire(
      pathToFileURL(path.join(pluginWorkspace(), "package.json")),
    );
    const entry = workspaceRequire.resolve(manifest.name);
    expect(fs.realpathSync(entry)).toBe(fs.realpathSync(path.join(packageRoot, "src", "index.ts")));

    const exports = await import(pathToFileURL(entry).href);
    expect(typeof exports.default).toBe("function");
  });
});
