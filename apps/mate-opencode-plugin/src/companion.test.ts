import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";

mock.module("@opencode-ai/plugin", () => ({
  tool: (definition: unknown) => definition,
}));

const { CompanionPlugin } = await import("./companion");
const { extractPatchPaths } = await import("@uniqbit/mate-core/opencode");

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return fn().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function input(directory: string): PluginInput {
  return { directory } as PluginInput;
}

/** Linked fixture: working repo pointer + companion config + trusted registration under a fake HOME. */
async function makeLinkedFixture(
  prefix: string,
  companionYaml = "type: companion\nallowedAgents:\n  - opencode\n",
  options: { trusted?: boolean } = {},
) {
  const root = await makeTempDir(prefix);
  const repo = path.join(root, "repo");
  const companion = path.join(root, "companion");
  const home = path.join(root, "home");
  await fs.mkdir(path.join(repo, ".mate", "config"), { recursive: true });
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.mkdir(path.join(home, ".mate"), { recursive: true });

  await fs.writeFile(
    path.join(repo, ".mate", "config", "registry.yaml"),
    [
      "repository:",
      "  id: acme",
      `  path: ${repo}`,
      "companions:",
      `  - path: ${companion}`,
      "    repositoryId: acme",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(companion, ".mate", "config", "framework.yaml"),
    companionYaml,
    "utf8",
  );
  if (options.trusted !== false) {
    await fs.writeFile(
      path.join(home, ".mate", "config.yaml"),
      ["version: 1", "companions:", `  - path: ${companion}`, ""].join("\n"),
      "utf8",
    );
  }
  return { root, repo, companion, home };
}

const NO_LAUNCH_ENV = {
  MATE_ARTIFACT_PATH: undefined,
  MATE_REPO_PATH: undefined,
  MATE_REPO_ID: undefined,
  MATE_POLICY_JSON: undefined,
  MATE_GIT_AUTO_MODE: undefined,
  MATE_GUIDANCE_JSON: undefined,
};

describe("OpenCode companion plugin", () => {
  test("exposes companion bin metadata and shell env for explicit wrapper resolution", async () => {
    const root = await makeTempDir("mate-opencode-metadata-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_VERSION: "0.14.0-test",
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_WRAPPER_BIN_PATH: "/package/wrappers/bin",
        MATE_NAME: "mate",
        PATH: "/usr/bin",
      },
      async () => {
        const plugin = await CompanionPlugin(input(repo));
        const toolDef = plugin.tool?.companion_paths as
          | { execute?: () => Promise<{ output: string; metadata?: Record<string, string> }> }
          | undefined;
        const result = await toolDef?.execute?.();
        const payload = JSON.parse(result?.output ?? "{}");

        expect(payload.wrapperBinPath).toBe("/package/wrappers/bin");
        expect(result?.metadata?.wrapperBinPath).toBe("/package/wrappers/bin");

        const envHook = plugin["shell.env"] as
          | ((input: unknown, output: { env: Record<string, string> }) => Promise<void>)
          | undefined;
        const output = { env: {} as Record<string, string> };
        await envHook?.({}, output);

        expect(output.env.MATE_WRAPPER_BIN_PATH).toBe("/package/wrappers/bin");
        expect(output.env.MATE_VERSION).toBe("0.14.0-test");
        expect(output.env.MATE_NAME).toBe("mate");
        expect(output.env.PATH).toBe("/package/wrappers/bin:/usr/bin");

        const transform = plugin["experimental.chat.system.transform"] as
          | ((input: unknown, output: { system: string[] }) => Promise<void>)
          | undefined;
        const prompt = { system: ["base"] };
        await transform?.({}, prompt);

        expect(prompt.system[0]).toContain("/package/wrappers/bin/openspec");
        expect(prompt.system[0]).toContain("<cli-tools>");
        expect(prompt.system[0]).toContain('name="mate" type="global"');
      },
    );
  });

  test("injects companion AGENTS.md into system prompt", async () => {
    const root = await makeTempDir("mate-opencode-agents-md-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(companion, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(
      path.join(companion, "AGENTS.md"),
      "# Agent Instructions\nAlways be nice.\n",
      "utf8",
    );

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const plugin = await CompanionPlugin(input(repo));
        const transform = plugin["experimental.chat.system.transform"] as
          | ((input: unknown, output: { system: string[] }) => Promise<void>)
          | undefined;
        const prompt = { system: ["base"] };
        await transform?.({}, prompt);

        expect(prompt.system[0]).toContain("<agents.md>");
        expect(prompt.system[0]).toContain("# Agent Instructions");
        expect(prompt.system[0]).toContain("Always be nice.");
        expect(prompt.system[0]).toContain("</agents.md>");
      },
    );
  });

  test("skips AGENTS.md injection when file does not exist", async () => {
    const root = await makeTempDir("mate-opencode-no-agents-md-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(companion, { recursive: true });
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const plugin = await CompanionPlugin(input(repo));
        const transform = plugin["experimental.chat.system.transform"] as
          | ((input: unknown, output: { system: string[] }) => Promise<void>)
          | undefined;
        const prompt = { system: ["base"] };
        await transform?.({}, prompt);

        expect(prompt.system[0]).not.toContain("<agents.md>");
      },
    );
  });

  test("plain start in a linked repository activates from the repo-local pointer", async () => {
    const fixture = await makeLinkedFixture("mate-opencode-plain-start-");

    await withEnv({ ...NO_LAUNCH_ENV, HOME: fixture.home }, async () => {
      const plugin = await CompanionPlugin(input(fixture.repo));

      const transform = plugin["experimental.chat.system.transform"] as
        | ((input: unknown, output: { system: string[] }) => Promise<void>)
        | undefined;
      expect(transform).toBeFunction();
      const prompt = { system: [] as string[] };
      await transform?.({}, prompt);
      expect(prompt.system[0]).toContain("<companion-policy ");
      expect(prompt.system[0]).toContain(path.resolve(fixture.companion));

      const envHook = plugin["shell.env"] as
        | ((input: unknown, output: { env: Record<string, string> }) => Promise<void>)
        | undefined;
      const output = { env: {} as Record<string, string> };
      await envHook?.({}, output);
      expect(output.env.MATE_ARTIFACT_PATH).toBe(path.resolve(fixture.companion));
      expect(output.env.MATE_REPO_ID).toBe("acme");
    });
  });

  test("stays inert in a non-Mate directory", async () => {
    const dir = await makeTempDir("mate-opencode-inert-");
    const home = await makeTempDir("mate-opencode-inert-home-");

    await withEnv({ ...NO_LAUNCH_ENV, HOME: home }, async () => {
      expect(await CompanionPlugin(input(dir))).toEqual({});
    });
  });

  test("warns and stays inert on an untrusted committed pointer", async () => {
    const fixture = await makeLinkedFixture("mate-opencode-untrusted-", undefined, {
      trusted: false,
    });

    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await withEnv({ ...NO_LAUNCH_ENV, HOME: fixture.home }, async () => {
        expect(await CompanionPlugin(input(fixture.repo))).toEqual({});
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(chunks.join("")).toContain("untrusted");
    expect(chunks.join("")).toContain(path.resolve(fixture.companion));
  });

  test("guidance reflects the live capability configuration on each session start", async () => {
    const fixture = await makeLinkedFixture(
      "mate-opencode-live-config-",
      "type: companion\nallowedAgents:\n  - opencode\ncapabilities:\n  - name: tokensave\n",
    );

    await withEnv({ ...NO_LAUNCH_ENV, HOME: fixture.home }, async () => {
      const first = await CompanionPlugin(input(fixture.repo));
      const firstPrompt = { system: [] as string[] };
      await (
        first["experimental.chat.system.transform"] as (
          input: unknown,
          output: { system: string[] },
        ) => Promise<void>
      )({}, firstPrompt);
      expect(firstPrompt.system[0]).toContain("tokensave");
      expect(firstPrompt.system[0]).not.toContain("graphify query");

      // Capability enabled after the previous session: the next start reflects it.
      await fs.writeFile(
        path.join(fixture.companion, ".mate", "config", "framework.yaml"),
        "type: companion\nallowedAgents:\n  - opencode\ncapabilities:\n  - name: tokensave\n  - name: graphify\n",
        "utf8",
      );

      const second = await CompanionPlugin(input(fixture.repo));
      const secondPrompt = { system: [] as string[] };
      await (
        second["experimental.chat.system.transform"] as (
          input: unknown,
          output: { system: string[] },
        ) => Promise<void>
      )({}, secondPrompt);
      expect(secondPrompt.system[0]).toContain("graphify query");
    });
  });

  test("ambiguous companions inject the selection prompt instead of activating", async () => {
    const fixture = await makeLinkedFixture("mate-opencode-ambiguous-");
    const secondCompanion = path.join(fixture.root, "companion-b");
    await fs.mkdir(secondCompanion, { recursive: true });
    await fs.writeFile(
      path.join(fixture.repo, ".mate", "config", "registry.yaml"),
      [
        "repository:",
        "  id: acme",
        `  path: ${fixture.repo}`,
        "companions:",
        `  - path: ${fixture.companion}`,
        "    repositoryId: acme",
        `  - path: ${secondCompanion}`,
        "    repositoryId: acme",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture.home, ".mate", "config.yaml"),
      [
        "version: 1",
        "companions:",
        `  - path: ${fixture.companion}`,
        `  - path: ${secondCompanion}`,
        "",
      ].join("\n"),
      "utf8",
    );

    await withEnv({ ...NO_LAUNCH_ENV, HOME: fixture.home }, async () => {
      const plugin = await CompanionPlugin(input(fixture.repo));
      expect(plugin["shell.env"]).toBeUndefined();
      expect(plugin.tool).toBeUndefined();

      const prompt = { system: [] as string[] };
      await (
        plugin["experimental.chat.system.transform"] as (
          input: unknown,
          output: { system: string[] },
        ) => Promise<void>
      )({}, prompt);
      expect(prompt.system.join("\n")).toContain("companion select");
      expect(prompt.system.join("\n")).toContain("ask the user");
      expect(prompt.system.join("\n")).toContain("reactivates automatically");
    });
  });

  test("ambiguous session disposes the instance once a companion gets pinned", async () => {
    const fixture = await makeLinkedFixture("mate-opencode-reactivate-");
    const secondCompanion = path.join(fixture.root, "companion-b");
    await fs.mkdir(secondCompanion, { recursive: true });
    const registryWithout = (selected?: string) =>
      [
        "repository:",
        "  id: acme",
        `  path: ${fixture.repo}`,
        "companions:",
        `  - path: ${fixture.companion}`,
        "    repositoryId: acme",
        `  - path: ${secondCompanion}`,
        "    repositoryId: acme",
        ...(selected ? [`selectedCompanionPath: ${selected}`] : []),
        "",
      ].join("\n");
    await fs.writeFile(
      path.join(fixture.repo, ".mate", "config", "registry.yaml"),
      registryWithout(),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture.home, ".mate", "config.yaml"),
      [
        "version: 1",
        "companions:",
        `  - path: ${fixture.companion}`,
        `  - path: ${secondCompanion}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const dispose = mock(async () => ({}));
    const showToast = mock(async () => ({}));
    const client = { instance: { dispose }, tui: { showToast } };

    await withEnv({ ...NO_LAUNCH_ENV, HOME: fixture.home }, async () => {
      const plugin = await CompanionPlugin({
        directory: fixture.repo,
        client,
      } as unknown as PluginInput);
      const onEvent = plugin.event as (input: { event: { type: string } }) => Promise<void>;

      await onEvent({ event: { type: "session.idle" } });
      expect(dispose).not.toHaveBeenCalled();

      await fs.writeFile(
        path.join(fixture.repo, ".mate", "config", "registry.yaml"),
        registryWithout(fixture.companion),
        "utf8",
      );
      await onEvent({ event: { type: "message.updated" } });
      expect(dispose).not.toHaveBeenCalled();

      await onEvent({ event: { type: "session.idle" } });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledTimes(1);

      await onEvent({ event: { type: "session.idle" } });
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  test("active session disposes the instance when the pin switches to another companion", async () => {
    const fixture = await makeLinkedFixture("mate-opencode-switch-");
    const secondCompanion = path.join(fixture.root, "companion-b");
    await fs.mkdir(secondCompanion, { recursive: true });
    const registryPinnedTo = (selected: string) =>
      [
        "repository:",
        "  id: acme",
        `  path: ${fixture.repo}`,
        "companions:",
        `  - path: ${fixture.companion}`,
        "    repositoryId: acme",
        `  - path: ${secondCompanion}`,
        "    repositoryId: acme",
        `selectedCompanionPath: ${selected}`,
        "",
      ].join("\n");
    await fs.writeFile(
      path.join(fixture.repo, ".mate", "config", "registry.yaml"),
      registryPinnedTo(fixture.companion),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture.home, ".mate", "config.yaml"),
      [
        "version: 1",
        "companions:",
        `  - path: ${fixture.companion}`,
        `  - path: ${secondCompanion}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const dispose = mock(async () => ({}));
    const showToast = mock(async () => ({}));
    const client = { instance: { dispose }, tui: { showToast } };

    await withEnv({ ...NO_LAUNCH_ENV, HOME: fixture.home }, async () => {
      const plugin = await CompanionPlugin({
        directory: fixture.repo,
        client,
      } as unknown as PluginInput);
      expect(plugin["shell.env"]).toBeDefined();
      const onEvent = plugin.event as (input: { event: { type: string } }) => Promise<void>;

      await onEvent({ event: { type: "session.idle" } });
      expect(dispose).not.toHaveBeenCalled();

      await fs.writeFile(
        path.join(fixture.repo, ".mate", "config", "registry.yaml"),
        registryPinnedTo(secondCompanion),
        "utf8",
      );
      await onEvent({ event: { type: "session.idle" } });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledTimes(1);
    });
  });

  test("injects companion skills paths and the static gateway MCP entry through the config hook", async () => {
    const fixture = await makeLinkedFixture("mate-opencode-config-hook-");
    /* companion-authored MCP servers must NOT be merged — the gateway delivers them */
    await fs.mkdir(path.join(fixture.companion, ".opencode"), { recursive: true });
    await fs.writeFile(
      path.join(fixture.companion, ".opencode", "opencode.json"),
      JSON.stringify({
        mcp: { tokensave: { type: "local", command: ["tokensave", "serve"], enabled: true } },
      }),
      "utf8",
    );

    await withEnv({ ...NO_LAUNCH_ENV, HOME: fixture.home }, async () => {
      const plugin = await CompanionPlugin(input(fixture.repo));
      const config: Record<string, any> = {
        mcp: { user: { type: "local", command: ["user-server"], enabled: true } },
      };
      await (plugin.config as (cfg: unknown) => Promise<void>)(config);

      const companionPath = path.resolve(fixture.companion);
      expect(config.permission.external_directory[companionPath]).toBe("allow");
      expect(config.skills.paths).toContain(path.join(companionPath, ".agents", "skills"));
      expect(config.mcp.mate).toEqual({
        type: "local",
        command: ["mate", "mcp", "shim"],
        enabled: true,
      });
      expect(config.mcp.tokensave).toBeUndefined();
      expect(config.mcp.user).toEqual({ type: "local", command: ["user-server"], enabled: true });
    });
  });

  test("a user-defined mate MCP entry is not overwritten by the gateway entry", async () => {
    const fixture = await makeLinkedFixture("mate-opencode-config-hook-user-mate-");

    await withEnv({ ...NO_LAUNCH_ENV, HOME: fixture.home }, async () => {
      const plugin = await CompanionPlugin(input(fixture.repo));
      const config: Record<string, any> = {
        mcp: { mate: { type: "local", command: ["custom-mate"], enabled: false } },
      };
      await (plugin.config as (cfg: unknown) => Promise<void>)(config);

      expect(config.mcp.mate).toEqual({ type: "local", command: ["custom-mate"], enabled: false });
    });
  });

  test("extractPatchPaths parses marker lines from patchText", () => {
    const patchText = `*** Add File: openspec/changes/foo/spec.md
+++ b/openspec/changes/foo/spec.md
some content
*** Update File: src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
more content
*** Delete File: old/tasks.md
`;

    const paths = extractPatchPaths(patchText);
    expect(paths).toEqual(["openspec/changes/foo/spec.md", "src/main.ts", "old/tasks.md"]);
  });

  test("extractPatchPaths returns empty array for patch without markers", () => {
    const patchText = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n";
    expect(extractPatchPaths(patchText)).toEqual([]);
  });
});
