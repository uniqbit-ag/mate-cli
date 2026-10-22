import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { SetupContext } from "@uniqbit/mate-core";

import createPlugin from "./index";

const packageRoot = path.resolve(import.meta.dir, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setupContext(): SetupContext {
  const companionPath = fs.mkdtempSync(path.join(os.tmpdir(), "companion-mentions-"));
  tempRoots.push(companionPath);
  return {
    companionPath,
    config: { allowedAgents: ["claude", "opencode"], capabilities: [] },
    mode: "sync",
    activeProviders: ["claude", "opencode"],
  };
}

async function contributions() {
  return createPlugin(undefined).getRuntimeContributions!(setupContext());
}

describe("createPlugin", () => {
  test("returns the companion-mentions Capability", () => {
    const plugin = createPlugin(undefined);
    expect(plugin.id).toBe("companion-mentions");
    expect(plugin.kind).toBe("capability");
    expect(plugin.defaultSelected).toBe(false);
  });

  test("contributes its own claude-plugin folder as the one Claude plugin directory", async () => {
    const directories = (await contributions()).claude?.pluginDirectories ?? [];
    expect(directories).toEqual([{ path: path.join(packageRoot, "claude-plugin") }]);
    expect(
      fs.statSync(path.join(directories[0]!.path, ".claude-plugin", "plugin.json")).isFile(),
    ).toBe(true);
  });

  test("contributes a canonical path: absolute, normalized, no trailing separator", async () => {
    const [directory] = (await contributions()).claude?.pluginDirectories ?? [];
    expect(path.isAbsolute(directory!.path)).toBe(true);
    expect(path.normalize(directory!.path)).toBe(directory!.path);
    expect(directory!.path.endsWith(path.sep)).toBe(false);
    expect(path.dirname(directory!.path)).toBe(path.dirname(path.join(packageRoot, "src")));
  });

  test("contributes nothing to other runtimes", async () => {
    expect(Object.keys(await contributions())).toEqual(["claude"]);
  });

  test("writes no file on apply or teardown", async () => {
    const plugin = createPlugin(undefined);
    const ctx = setupContext();
    await plugin.apply(ctx);
    await plugin.teardown(ctx);
    expect(fs.readdirSync(ctx.companionPath)).toEqual([]);
  });

  test.each([undefined, null, {}])("accepts the configuration %p", (config) => {
    expect(createPlugin(config).id).toBe("companion-mentions");
  });

  test("rejects an unknown option, naming the package and the key", () => {
    expect(() => createPlugin({ rows: 5 })).toThrow(
      /@uniqbit\/mate-plugin-companion-mentions takes no configuration.*rows/,
    );
  });

  test.each([[["rows"]], "rows", 5])("rejects the configuration %p", (config) => {
    expect(() => createPlugin(config)).toThrow("@uniqbit/mate-plugin-companion-mentions");
  });
});
