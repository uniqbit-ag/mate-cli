import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin";

import { AddDirPlugin } from "./add-dir";

type ConfigHook = NonNullable<Hooks["config"]>;

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function input(directory: string): PluginInput {
  return { directory } as PluginInput;
}

describe("OpenCode add-dir plugin", () => {
  test("adds companion path external_directory allow rules without replacing user config", async () => {
    const dir = await makeTempDir("mate-add-dir-");
    await withEnv({ MATE_ARTIFACT_PATH: "/tmp/companion", MATE_REPO_PATH: dir }, async () => {
      const plugin = await AddDirPlugin(input(dir));
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

  test("does nothing in a non-Mate directory without launch env", async () => {
    const dir = await makeTempDir("mate-add-dir-inert-");
    await withEnv({ MATE_ARTIFACT_PATH: undefined, MATE_REPO_PATH: undefined }, async () => {
      const plugin = await AddDirPlugin(input(dir));

      expect(plugin).toEqual({});
    });
  });

  test("preserves existing companion path rules", async () => {
    const dir = await makeTempDir("mate-add-dir-preserve-");
    await withEnv({ MATE_ARTIFACT_PATH: "/tmp/companion", MATE_REPO_PATH: dir }, async () => {
      const plugin = await AddDirPlugin(input(dir));
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
