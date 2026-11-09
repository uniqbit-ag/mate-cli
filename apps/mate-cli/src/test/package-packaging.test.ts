/** @test-requires network */

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  packRelease,
  withPublishedPackageVersions,
  withReleaseVersions,
  type PackageMetadata,
  type PackedTarball,
} from "../../../mate-container/src/image-pins";

const tempRoots: string[] = [];

function smokeInputs(
  manifest: string,
  lock: string,
  version: string,
  packages: PackageMetadata[],
  packed: ReadonlyMap<string, PackedTarball>,
): { manifest: string; lock: string } {
  const integrities = new Map([...packed].map(([name, tarball]) => [name, tarball.integrity]));
  const updated = JSON.parse(
    withPublishedPackageVersions(lock, version, packages, integrities),
  ) as {
    packages: Record<string, { resolved?: string }>;
  };
  for (const [name, tarball] of packed) {
    updated.packages[`node_modules/${name}`]!.resolved = `file:${tarball.tarball}`;
  }
  return {
    manifest: withReleaseVersions(manifest, version),
    lock: `${JSON.stringify(updated, null, 2)}\n`,
  };
}

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
  test("rejects release dependency drift before installing", () => {
    const manifest = JSON.stringify({ dependencies: { "@uniqbit/mate-core": "1.4.0" } });
    const lock = JSON.stringify(
      {
        packages: {
          "": { dependencies: { "@uniqbit/mate-core": "1.4.0" } },
          "node_modules/@uniqbit/mate-core": {
            version: "1.4.0",
            resolved: "https://example.invalid/acme.tgz",
            integrity: "sha512-acme",
          },
        },
      },
      null,
      2,
    );
    expect(() =>
      smokeInputs(
        manifest,
        lock,
        "1.5.0",
        [{ name: "@uniqbit/mate-core", version: "1.5.0", dependencies: { "acme-dep": "1.0.0" } }],
        new Map([["@uniqbit/mate-core", { tarball: "/acme.tgz", integrity: "sha512-acme" }]]),
      ),
    ).toThrow("acme-dep");
  });

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

  test("loads the thin CLI with the matching packed core, which bundles the OpenCode plugin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-cli-package-smoke-"));
    tempRoots.push(root);

    const cliRoot = path.join(import.meta.dirname, "../..");
    const workspaceRoot = path.resolve(cliRoot, "../..");
    const coreRoot = path.join(workspaceRoot, "packages", "mate-core");
    const manifest = JSON.parse(
      await fs.readFile(path.join(cliRoot, "package.json"), "utf8"),
    ) as PackageMetadata;
    const coreManifest = JSON.parse(
      await fs.readFile(path.join(coreRoot, "package.json"), "utf8"),
    ) as PackageMetadata;
    const packed = packRelease(manifest.version, workspaceRoot, root);
    const locks = path.join(workspaceRoot, "apps/mate-container/locks");
    const imageManifest = await fs.readFile(path.join(locks, "global-tools.package.json"), "utf8");
    const imageLock = await fs.readFile(path.join(locks, "global-tools.package-lock.json"), "utf8");
    const smoke = smokeInputs(
      imageManifest,
      imageLock,
      manifest.version,
      [coreManifest, manifest],
      packed,
    );

    const project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "package.json"), smoke.manifest, "utf8");
    await fs.writeFile(path.join(project, "package-lock.json"), smoke.lock, "utf8");

    const install = spawnSync(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: project,
        env: { ...process.env, CI: "1" },
        encoding: "utf8",
      },
    );
    expect(`${install.stderr}\n${install.stdout}`).not.toContain("error:");
    expect(install.status).toBe(0);
    const installedLock = JSON.parse(
      await fs.readFile(path.join(project, "node_modules/.package-lock.json"), "utf8"),
    ) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const committedLock = JSON.parse(imageLock) as typeof installedLock;
    for (const [key, entry] of Object.entries(installedLock.packages)) {
      if (key === "node_modules/@uniqbit/mate" || key === "node_modules/@uniqbit/mate-core")
        continue;
      expect(entry.version).toBe(committedLock.packages[key]?.version);
      expect(entry.integrity).toBe(committedLock.packages[key]?.integrity);
    }

    const mate = path.join(project, "node_modules", ".bin", "mate");
    const installedMateRoot = path.join(project, "node_modules", "@uniqbit", "mate");
    const installedCoreRoot = path.join(project, "node_modules", "@uniqbit", "mate-core");
    const nestedCoreRoot = path.join(installedMateRoot, "node_modules", "@uniqbit", "mate-core");
    /** No separate plugin package: the plugin ships inside mate-core. */
    await expect(
      fs.stat(path.join(project, "node_modules", "@uniqbit", "mate-opencode-plugin")),
    ).rejects.toThrow();
    await fs.access(path.join(installedCoreRoot, "opencode-plugin", "server.ts"));
    await fs.mkdir(path.dirname(nestedCoreRoot), { recursive: true });
    await fs.rename(installedCoreRoot, nestedCoreRoot);

    const version = spawnSync(mate, ["--version"], {
      cwd: project,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
    });
    expect(version.status).toBe(0);
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
        'if [ "$1" = "install" ]; then printf "%s\\n" "$@" >> "$NPM_CAPTURE"; exit 0; fi',
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
        MATE_ARTIFACT_PATH: "",
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
