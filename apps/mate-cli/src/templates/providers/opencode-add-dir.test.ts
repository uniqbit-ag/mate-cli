import { describe, expect, test } from "bun:test";
import type { Config, Hooks } from "@opencode-ai/plugin";

import { AddDirPlugin } from "./opencode/plugins/mate-add-dir";

type ConfigHook = NonNullable<Hooks["config"]>;

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

  test("does nothing when MATE_ARTIFACT_PATH is absent", async () => {
    await withEnv("MATE_ARTIFACT_PATH", undefined, async () => {
      const plugin = await AddDirPlugin();

      expect(plugin).toEqual({});
    });
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
