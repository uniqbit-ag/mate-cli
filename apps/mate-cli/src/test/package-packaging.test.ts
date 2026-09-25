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
}, 60_000);

async function packInto(packageRoot: string, destination: string): Promise<string> {
  await fs.mkdir(destination, { recursive: true });
  const pack = spawnSync("bun", ["pm", "pack", "--destination", destination], {
    cwd: packageRoot,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
  });
  expect(pack.status).toBe(0);

  const tarball = (await fs.readdir(destination)).find((entry) => entry.endsWith(".tgz"));
  expect(tarball).toBeDefined();
  return path.join(destination, tarball!);
}

describe("published package", () => {
  test("packs the bin bootstrap (wrappers ship in @uniqbit/mate-core)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-package-smoke-"));
    tempRoots.push(root);
    const packageRoot = path.join(import.meta.dirname, "../..");

    const extracted = path.join(root, "extracted");
    await fs.mkdir(extracted);
    const tarball = await packInto(packageRoot, root);
    const unpack = spawnSync("tar", ["-xzf", tarball, "-C", extracted], {
      encoding: "utf8",
    });
    expect(unpack.status).toBe(0);

    // Wrappers are packaged by @uniqbit/mate-core now; the distribution
    // tarball ships only the bin and distribution config.
    await expect(fs.stat(path.join(extracted, "package", "wrappers"))).rejects.toThrow();

    const bootstrap = path.join(extracted, "package", "src", "cli-bootstrap.cjs");
    await expect(fs.stat(bootstrap)).resolves.toBeDefined();
    await expect(fs.readFile(bootstrap, "utf8")).resolves.toContain("Install Bun now?");
  }, 30_000);

  test("loads the thin CLI with matching packed core and plugin artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-cli-package-smoke-"));
    tempRoots.push(root);

    const cliRoot = path.join(import.meta.dirname, "../..");
    const coreRoot = path.join(cliRoot, "..", "..", "packages", "mate-core");
    const pluginRoot = path.join(cliRoot, "..", "mate-opencode-plugin");
    const coreTarball = await packInto(coreRoot, path.join(root, "core"));
    const pluginTarball = await packInto(pluginRoot, path.join(root, "plugin"));
    const cliTarball = await packInto(cliRoot, path.join(root, "cli"));

    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify(
        {
          name: "mate-cli-package-smoke",
          private: true,
          dependencies: {
            "@uniqbit/mate": `file:${cliTarball}`,
          },
          overrides: {
            "@uniqbit/mate-core": `file:${coreTarball}`,
            "@uniqbit/mate-opencode-plugin": `file:${pluginTarball}`,
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

    const mate = path.join(project, "node_modules", ".bin", "mate");
    const installedMateRoot = path.join(project, "node_modules", "@uniqbit", "mate");
    const installedCoreRoot = path.join(project, "node_modules", "@uniqbit", "mate-core");
    const nestedCoreRoot = path.join(installedMateRoot, "node_modules", "@uniqbit", "mate-core");
    await fs.mkdir(path.dirname(nestedCoreRoot), { recursive: true });
    await fs.rename(installedCoreRoot, nestedCoreRoot);

    const version = spawnSync(mate, ["--version"], {
      cwd: project,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
    });
    expect(version.status).toBe(0);
    const manifest = JSON.parse(await fs.readFile(path.join(cliRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(version.stdout.trim()).toBe(manifest.version);

    const help = spawnSync(mate, ["--help"], {
      cwd: project,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("mate studio");

    const fakeBin = path.join(root, "fake-bin");
    const npmCapture = path.join(root, "npm-install-args");
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      path.join(fakeBin, "npm"),
      [
        "#!/bin/sh",
        'if [ "$1" = "view" ]; then printf "99.0.0\\n"; exit 0; fi',
        'if [ "$1" = "root" ]; then printf "%s\\n" "$NPM_GLOBAL_ROOT"; exit 0; fi',
        'if [ "$1" = "install" ]; then printf "%s\\n" "$@" > "$NPM_CAPTURE"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(path.join(fakeBin, "npm"), 0o755);

    const update = spawnSync(mate, ["update", "--yes"], {
      cwd: project,
      env: {
        ...process.env,
        CI: "1",
        HOME: path.join(root, "home"),
        MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
        NPM_CAPTURE: npmCapture,
        NPM_GLOBAL_ROOT: path.join(project, "node_modules"),
        PATH: [fakeBin, path.dirname(process.execPath), process.env.PATH ?? ""].join(
          path.delimiter,
        ),
      },
      encoding: "utf8",
    });
    expect(update.status).toBe(0);
    expect(update.stderr).not.toContain("self-update is only supported");
    expect(update.stdout).toContain("Upgraded to 99.0.0.");
    expect(await fs.readFile(npmCapture, "utf8")).toContain("@uniqbit/mate@99.0.0");
  }, 240_000);
});
