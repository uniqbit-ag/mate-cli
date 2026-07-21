import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@opencode-ai/plugin", () => ({
  tool: (definition: unknown) => definition,
}));

const { CompanionPlugin } = await import("./opencode/plugins/mate-companion");
const { extractPatchPaths } = await import("./opencode/plugins/mate-companion-policy");

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function writeGuidanceFile(companion: string): Promise<void> {
  await fs.mkdir(path.join(companion, ".opencode"), { recursive: true });
  await fs.writeFile(
    path.join(companion, ".opencode", ".mate-guidance.json"),
    JSON.stringify(
      {
        version: 1,
        companionGuidance:
          '<companion-policy framework="mate" priority="mandatory"><context><paths><path role="package-wrapper-bin" env="MATE_WRAPPER_BIN_PATH">$MATE_WRAPPER_BIN_PATH</path></paths><cli-tools><cli name="openspec" type="wrapper" invokeAs="$MATE_WRAPPER_BIN_PATH/openspec" /><cli name="graphify" type="wrapper" invokeAs="$MATE_WRAPPER_BIN_PATH/graphify" /><cli name="mate" type="global" invokeAs="mate" /></cli-tools></context><mandatory-rules><rule id="artifact-location" severity="critical">test</rule></mandatory-rules></companion-policy>',
        codebaseExplorationGuidance: "",
        errors: [],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
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

describe("OpenCode companion plugin", () => {
  test("exposes companion bin metadata and shell env for explicit wrapper resolution", async () => {
    const root = await makeTempDir("mate-opencode-metadata-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await writeGuidanceFile(companion);

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_VERSION: "0.14.0-test",
        MATE_REPO_ID: "app",
        MATE_REPO_PROFILE: "default",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_WRAPPER_BIN_PATH: "/package/wrappers/bin",
        PATH: "/usr/bin",
      },
      async () => {
        const plugin = await CompanionPlugin();
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
    await writeGuidanceFile(companion);
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
        MATE_REPO_PROFILE: "default",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const plugin = await CompanionPlugin();
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
    await writeGuidanceFile(companion);

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_REPO_PROFILE: "default",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const plugin = await CompanionPlugin();
        const transform = plugin["experimental.chat.system.transform"] as
          | ((input: unknown, output: { system: string[] }) => Promise<void>)
          | undefined;
        const prompt = { system: ["base"] };
        await transform?.({}, prompt);

        expect(prompt.system[0]).not.toContain("<agents.md>");
      },
    );
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
