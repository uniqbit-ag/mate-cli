import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { Config, Hooks } from "@opencode-ai/plugin";
import { MATE_ENV, renderProjectionEnv, renderProjectionYaml } from "@uniqbit/mate-core/runtime";

import { AddDirPlugin } from "./add-dir";

type ConfigHook = NonNullable<Hooks["config"]>;

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
}

/** Clears every launch variable and runs from a wrapped Working Repository. */
async function inUnmanagedSession<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const previousEnv = new Map<string, string | undefined>();
  for (const name of Object.values(MATE_ENV)) {
    previousEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function wrappedRepo(companionPath: string): string {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-add-dir-")));
  tempRoots.push(repoRoot);
  const mateDir = path.join(repoRoot, ".mate");
  fs.mkdirSync(path.join(mateDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(mateDir, "config", "registry.yaml"), "companions: []\n", "utf8");
  const file = {
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: path.join(companionPath, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  };
  fs.writeFileSync(path.join(mateDir, "projection.yaml"), renderProjectionYaml(file), "utf8");
  fs.writeFileSync(path.join(mateDir, "projection.env"), renderProjectionEnv(file), "utf8");
  return repoRoot;
}

describe("OpenCode add-dir plugin", () => {
  test("adds companion path external_directory allow rules without replacing user config", async () => {
    await withEnv("MATE_ARTIFACT_PATH", "/tmp/companion", async () => {
      const plugin = await AddDirPlugin();
      const config: Config = {
        permission: {
          external_directory: {
            "/tmp/custom": "deny",
          },
        },
      };

      await (plugin.config as ConfigHook | undefined)?.(config);

      expect(config).toEqual({
        permission: {
          external_directory: {
            "/tmp/custom": "deny",
            "/tmp/companion": "allow",
            "/tmp/companion/**": "allow",
          },
        },
      });
    });
  });

  test("registers no rules when neither the environment nor a projection resolves", async () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-add-dir-bare-")));
    tempRoots.push(bare);

    const plugin = await inUnmanagedSession(bare, () => AddDirPlugin());

    expect(plugin).toEqual({});
  });

  test("allow-lists the projected companion when the environment is empty", async () => {
    const repoRoot = wrappedRepo("/tmp/projected-companion");

    const plugin = await inUnmanagedSession(repoRoot, () => AddDirPlugin());
    const config: Config = {};
    await (plugin.config as ConfigHook | undefined)?.(config);

    expect(config).toEqual({
      permission: {
        external_directory: {
          "/tmp/projected-companion": "allow",
          "/tmp/projected-companion/**": "allow",
        },
      },
    });
  });

  test("the launch environment outranks the projection", async () => {
    const repoRoot = wrappedRepo("/tmp/projected-companion");

    const plugin = await inUnmanagedSession(repoRoot, () =>
      withEnv(MATE_ENV.companionPath, "/tmp/launched-companion", () => AddDirPlugin()),
    );
    const config: Config = {};
    await (plugin.config as ConfigHook | undefined)?.(config);

    expect(
      Object.keys((config.permission as { external_directory: object }).external_directory),
    ).toEqual(["/tmp/launched-companion", "/tmp/launched-companion/**"]);
  });

  test("spells no MATE_ variable name of its own", async () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "add-dir.ts"), "utf8");

    expect(source).not.toContain("MATE_");
  });

  test("preserves existing companion path rules", async () => {
    await withEnv("MATE_ARTIFACT_PATH", "/tmp/companion", async () => {
      const plugin = await AddDirPlugin();
      const config: Config = {
        permission: {
          external_directory: {
            "/tmp/companion": "deny",
            "/tmp/companion/**": "ask",
          },
        },
      };

      await (plugin.config as ConfigHook | undefined)?.(config);

      expect(config).toEqual({
        permission: {
          external_directory: {
            "/tmp/companion": "deny",
            "/tmp/companion/**": "ask",
          },
        },
      });
    });
  });
});
