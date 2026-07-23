import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function packInto(packageRoot: string, destination: string): Promise<string> {
  const pack = spawnSync("bun", ["pm", "pack", "--destination", destination], {
    cwd: packageRoot,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
  });
  expect(pack.status).toBe(0);

  const tarball = (await fs.readdir(destination)).find(
    (entry) => entry.endsWith(".tgz") && !tempRoots.includes(path.join(destination, entry)),
  );
  expect(tarball).toBeDefined();
  return path.join(destination, tarball!);
}

// Mirrors OpenCode's npm plugin loading: config references the package root,
// the loader selects the `./server` or `./tui` export subpath by plugin kind
// and imports the resolved entry point.
const LOADER_SCRIPT = `
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "node_modules", "@uniqbit", "mate-opencode-plugin");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const serverEntry = pkg.exports?.["./server"];
const tuiEntry = pkg.exports?.["./tui"];
if (!serverEntry) throw new Error("missing ./server export");
if (!tuiEntry) throw new Error("missing ./tui export");

const server = await import(path.join(root, serverEntry));
if (typeof server.default !== "function") throw new Error("./server default export is not a Plugin");

const hooks = await server.default({});
if (Object.keys(hooks).length !== 0) {
  throw new Error("aggregate plugin must stay inert without the Mate launch environment");
}

const tui = await import(path.join(root, tuiEntry));
if (typeof tui.default?.tui !== "function") {
  throw new Error("./tui default export is not a TuiPluginModule");
}

console.log("SMOKE_OK");
`;

describe("packed @uniqbit/mate-opencode-plugin", () => {
  test("loads ./server and ./tui outside the workspace through the OpenCode export contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-plugin-package-smoke-"));
    tempRoots.push(root);

    const pluginRoot = import.meta.dirname;
    const coreRoot = path.join(pluginRoot, "..", "..", "packages", "mate-core");

    const coreTarballDir = path.join(root, "core");
    const pluginTarballDir = path.join(root, "plugin");
    await fs.mkdir(coreTarballDir, { recursive: true });
    await fs.mkdir(pluginTarballDir, { recursive: true });
    const coreTarball = await packInto(coreRoot, coreTarballDir);
    const pluginTarball = await packInto(pluginRoot, pluginTarballDir);

    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify(
        {
          name: "mate-plugin-smoke",
          private: true,
          dependencies: {
            "@uniqbit/mate-opencode-plugin": `file:${pluginTarball}`,
          },
          // The packed plugin pins the coordinated (not yet published)
          // @uniqbit/mate-core version; resolve it from the packed tarball.
          overrides: {
            "@uniqbit/mate-core": `file:${coreTarball}`,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const install = spawnSync("bun", ["install", "--production"], {
      cwd: project,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
    });
    expect(`${install.stderr}\n${install.stdout}`).not.toContain("error:");
    expect(install.status).toBe(0);

    await fs.writeFile(path.join(project, "smoke.ts"), LOADER_SCRIPT, "utf8");

    // Strip Mate session variables so the inert-without-context check holds
    // even when this test itself runs inside a managed Mate session.
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("MATE_")),
    );
    const smoke = spawnSync("bun", ["smoke.ts"], {
      cwd: project,
      env: { ...cleanEnv, CI: "1" },
      encoding: "utf8",
    });

    expect(smoke.stderr).not.toContain("error");
    expect(smoke.stdout).toContain("SMOKE_OK");
    expect(smoke.status).toBe(0);
  }, 240_000);

  test("packed tarball ships only the source entry points and package manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-plugin-pack-files-"));
    tempRoots.push(root);

    const tarball = await packInto(import.meta.dirname, root);
    const list = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(list.status).toBe(0);

    const entries = list.stdout.split("\n").filter(Boolean);
    expect(entries).toContain("package/src/server.ts");
    expect(entries).toContain("package/src/tui.tsx");
    expect(entries).toContain("package/package.json");
    expect(entries.some((entry) => entry.includes("test"))).toBe(false);
  });
});
