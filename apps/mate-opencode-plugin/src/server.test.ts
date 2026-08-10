import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@opencode-ai/plugin", () => ({
  tool: (definition: unknown) => definition,
}));

const { MateOpenCodePlugin } = await import("./server");
const { ContextModePlugin } = await import("context-mode/plugin");

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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("aggregate Mate OpenCode plugin", () => {
  test("remains inert without launch env in a non-Mate directory", async () => {
    const dir = await makeTempDir("mate-opencode-server-inert-");
    const home = await makeTempDir("mate-opencode-server-inert-home-");
    await withEnv(
      {
        HOME: home,
        MATE_ARTIFACT_PATH: undefined,
        MATE_REPO_PATH: undefined,
        MATE_REPO_ID: undefined,
        MATE_POLICY_JSON: undefined,
        MATE_GIT_AUTO_MODE: undefined,
        MATE_GUIDANCE_JSON: undefined,
      },
      async () => {
        const hooks = await MateOpenCodePlugin({ directory: dir } as never);

        expect(hooks).toEqual({});
      },
    );
  });

  test("registers all regular Mate behavior for a managed session", async () => {
    const root = await makeTempDir("mate-opencode-aggregate-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "acme",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_WRAPPER_BIN_PATH: "/package/wrappers/bin",
      },
      async () => {
        const hooks = (await MateOpenCodePlugin({ directory: repo } as never)) as Record<
          string,
          unknown
        >;

        // add-dir module
        expect(hooks.config).toBeFunction();
        // companion-hooks module
        expect(hooks["tool.execute.before"]).toBeFunction();
        expect(hooks["tool.execute.after"]).toBeFunction();
        expect(hooks.event).toBeFunction();
        // companion module
        expect(hooks["experimental.chat.system.transform"]).toBeFunction();
        expect(hooks["experimental.session.compacting"]).toBeFunction();
        expect(hooks["shell.env"]).toBeFunction();
        expect((hooks.tool as Record<string, unknown>).companion_paths).toBeDefined();

        const config: Record<string, unknown> = {};
        await (hooks.config as (cfg: unknown) => Promise<void>)(config);
        expect(config.permission).toEqual({
          external_directory: {
            [companion]: "allow",
            [`${companion}/**`]: "allow",
          },
        });

        const prompt = { system: ["base"] };
        await (
          hooks["experimental.chat.system.transform"] as (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        )({}, prompt);
        expect(prompt.system).toHaveLength(1);
        expect(prompt.system[0]).toContain("<companion-policy ");
        expect(prompt.system[0]).toContain(companion);
      },
    );
  });

  test("builds guidance from the live companion configuration without a launch payload", async () => {
    const root = await makeTempDir("mate-opencode-aggregate-live-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(companion, { recursive: true });
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_GUIDANCE_JSON: undefined,
        MATE_REPO_ID: "acme",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const hooks = (await MateOpenCodePlugin({ directory: repo } as never)) as Record<
          string,
          unknown
        >;
        const prompt = { system: [] as string[] };
        await (
          hooks["experimental.chat.system.transform"] as (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        )({}, prompt);
        expect(prompt.system[0]).toContain("<companion-policy ");
        expect(prompt.system[0]).toContain(companion);
      },
    );
  });

  test("composes policy, routing, capture, guidance, and compaction hooks with context-mode", async () => {
    const root = await makeTempDir("mate-opencode-context-mode-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        HOME: root,
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "acme",
        MATE_POLICY_JSON: JSON.stringify({ forbiddenPaths: ["private/**"] }),
        MATE_GIT_AUTO_MODE: "0",
        MATE_WRAPPER_BIN_PATH: "/package/wrappers/bin",
      },
      async () => {
        const mate = (await MateOpenCodePlugin({ directory: repo } as never)) as Record<
          string,
          unknown
        >;
        const contextMode = (await ContextModePlugin({
          directory: repo,
          client: { app: { log: async () => {} } },
        })) as Record<string, unknown>;

        // OpenCode invokes each configured plugin independently, so matching
        // hook keys must remain present in both modules rather than being merged.
        for (const hook of [
          "tool.execute.before",
          "tool.execute.after",
          "experimental.chat.system.transform",
          "experimental.session.compacting",
        ]) {
          expect(mate[hook]).toBeFunction();
          expect(contextMode[hook]).toBeFunction();
        }
        expect(contextMode.tool).toBeObject();

        const system = { system: ["base"] };
        await (
          mate["experimental.chat.system.transform"] as (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        )({ sessionID: "session-acme", model: {} }, system);
        await (
          contextMode["experimental.chat.system.transform"] as (
            input: unknown,
            output: { system: string[] },
          ) => Promise<void>
        )({ sessionID: "session-acme", model: {} }, system);
        expect(system.system.join("\n")).toContain("<companion-policy ");
        expect(system.system.join("\n")).toContain("context-mode");
      },
    );
  });
});
