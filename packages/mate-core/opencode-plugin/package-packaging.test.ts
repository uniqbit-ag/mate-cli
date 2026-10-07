import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const tempRoots: string[] = [];

afterEach(async () => {
  /** A full `bun install` of the packed core can outrun bun's 5s default hook timeout on a loaded CI box. */
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
}, 60_000);

const CORE_ROOT = path.join(import.meta.dirname, "..");

async function packCore(destination: string): Promise<string> {
  const pack = spawnSync("bun", ["pm", "pack", "--destination", destination], {
    cwd: CORE_ROOT,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
  });
  expect(pack.status).toBe(0);

  const tarball = (await fs.readdir(destination)).find((entry) => entry.endsWith(".tgz"));
  expect(tarball).toBeDefined();
  return path.join(destination, tarball!);
}

/** Mirrors OpenCode's path-plugin loading: config names the directory, the loader imports `<dir>/server` or `<dir>/tui`. */
const LOADER_PRELUDE = `
import path from "node:path";

const root = path.join(process.cwd(), "node_modules", "@uniqbit", "mate-core", "opencode-plugin");
`;

const SERVER_LOADER_SCRIPT = `${LOADER_PRELUDE}
const server = await import(path.join(root, "server.ts"));
if (
  typeof server.default?.id !== "string" ||
  server.default.id.length === 0 ||
  typeof server.default.setup !== "function"
) {
  throw new Error("server default export is not a V2 server plugin definition");
}

/** Any domain access would throw: the plugin must stay inert without the Mate launch environment. */
const cleanup = await server.default.setup({ location: { directory: process.cwd() } });
if (cleanup !== undefined) {
  throw new Error("plugin must stay inert without the Mate launch environment");
}

console.log("SERVER_SMOKE_OK");
`;

const TUI_LOADER_SCRIPT = `${LOADER_PRELUDE}
const tui = await import(path.join(root, "tui.tsx"));
if (
  typeof tui.default?.id !== "string" ||
  tui.default.id.length === 0 ||
  typeof tui.default.setup !== "function"
) {
  throw new Error("tui default export is not a V2 TUI plugin module");
}

console.log("TUI_SMOKE_OK");
`;

function runInProject(project: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("bun", args, { cwd: project, env: { ...env, CI: "1" }, encoding: "utf8" });
}

describe("bundled OpenCode plugin in packed @uniqbit/mate-core", () => {
  test("ships the root entries and source modules without tests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-opencode-plugin-pack-files-"));
    tempRoots.push(root);

    const list = spawnSync("tar", ["-tzf", await packCore(root)], { encoding: "utf8" });
    expect(list.status).toBe(0);

    const entries = list.stdout
      .split("\n")
      .filter((entry) => entry.startsWith("package/opencode-plugin/"));
    for (const file of [
      "server.ts",
      "tui.tsx",
      "src/server.ts",
      "src/tui.tsx",
      "src/companion.ts",
    ]) {
      expect(entries).toContain(`package/opencode-plugin/${file}`);
    }
    expect(entries.filter((entry) => entry.includes(".test."))).toEqual([]);
  });

  test("loads the TUI entry with mate-core's OpenTUI and the server entry without OpenTUI, by path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-opencode-plugin-smoke-"));
    tempRoots.push(root);

    const tarballDir = path.join(root, "core");
    await fs.mkdir(tarballDir, { recursive: true });
    const coreTarball = await packCore(tarballDir);

    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify(
        {
          name: "mate-opencode-plugin-smoke",
          private: true,
          dependencies: { "@uniqbit/mate-core": `file:${coreTarball}` },
        },
        null,
        2,
      ),
      "utf8",
    );

    const install = runInProject(project, ["install", "--production"]);
    expect(`${install.stderr}\n${install.stdout}`).not.toContain("error:");
    expect(install.status).toBe(0);

    await fs.writeFile(path.join(project, "server-smoke.ts"), SERVER_LOADER_SCRIPT, "utf8");
    await fs.writeFile(path.join(project, "tui-smoke.ts"), TUI_LOADER_SCRIPT, "utf8");

    /** Strip Mate session variables so the inert-without-context check holds inside a managed session. */
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("MATE_")),
    );

    /** OpenCode does not hand its host OpenTUI to a path-loaded plugin; the TUI entry resolves mate-core's copy. */
    const tuiSmoke = runInProject(project, ["tui-smoke.ts"], cleanEnv);
    expect(tuiSmoke.stderr).not.toContain("error");
    expect(tuiSmoke.stdout).toContain("TUI_SMOKE_OK");
    expect(tuiSmoke.status).toBe(0);

    await fs.rm(path.join(project, "node_modules", "@opentui"), { recursive: true, force: true });

    const serverSmoke = runInProject(project, ["server-smoke.ts"], cleanEnv);
    expect(serverSmoke.stderr).not.toContain("error");
    expect(serverSmoke.stdout).toContain("SERVER_SMOKE_OK");
    expect(serverSmoke.status).toBe(0);
  }, 240_000);
});
