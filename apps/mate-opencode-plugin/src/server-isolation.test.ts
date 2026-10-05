import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const SERVER_ENTRY = path.join(import.meta.dirname, "server.ts");
const OPENTUI_PATTERN = /@opentui\/|solid-js/;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

/**
 * Runs `script` in a fresh Bun process so module evaluation and the OpenTUI
 * `globalThis` singleton start clean. Mate session variables are stripped so
 * the plugin stays inert.
 */
async function runIsolated(script: string): Promise<SpawnSyncReturns<string>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-plugin-server-isolation-"));
  tempRoots.push(root);
  const scriptPath = path.join(root, "probe.ts");
  await fs.writeFile(scriptPath, script, "utf8");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("MATE_")),
  );
  return spawnSync(process.execPath, [scriptPath], { env, encoding: "utf8" });
}

describe("./server OpenTUI isolation", () => {
  test("resolves no @opentui/* or solid-js module", async () => {
    const result = await runIsolated(`
import { plugin } from "bun";

const seen = new Set();
plugin({
  name: "resolve-recorder",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      seen.add(args.path);
      return undefined;
    });
  },
});

await import(${JSON.stringify(SERVER_ENTRY)});
console.log("RESOLVED " + JSON.stringify([...seen]));
`);

    expect(result.stderr).toBe("");
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESOLVED "));
    expect(line).toBeDefined();
    const resolved = JSON.parse(line!.slice("RESOLVED ".length)) as string[];
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.filter((specifier) => OPENTUI_PATTERN.test(specifier))).toEqual([]);
  });

  test("loads into a host whose OpenTUI env registry holds a conflicting schema", async () => {
    const result = await runIsolated(`
const bag = (globalThis[Symbol.for("@opentui/core/singleton")] ??= {});
bag["env-registry"] = {
  OPENTUI_FORCE_WCWIDTH: {
    name: "OPENTUI_FORCE_WCWIDTH",
    description: "Use wcwidth for character width calculations",
    type: "string",
    required: false,
  },
};

const server = await import(${JSON.stringify(SERVER_ENTRY)});
await server.default({});
console.log("CONFLICT_OK");
`);

    expect(result.stderr).not.toContain("already registered");
    expect(result.stdout).toContain("CONFLICT_OK");
    expect(result.status).toBe(0);
  });
});
