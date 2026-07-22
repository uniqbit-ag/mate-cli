import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@opencode-ai/plugin", () => ({
  tool: (definition: unknown) => definition,
}));

const { MateOpenCodePlugin } = await import("./server");

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const GUIDANCE_JSON = JSON.stringify({
  version: 1,
  companionGuidance:
    '<companion-policy framework="mate" priority="mandatory"><context><paths><path role="companion-repository" env="MATE_ARTIFACT_PATH">$MATE_ARTIFACT_PATH</path></paths></context><mandatory-rules><rule id="artifact-location" severity="critical">test</rule></mandatory-rules></companion-policy>',
  codebaseExplorationGuidance: "",
  errors: [],
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

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("aggregate Mate OpenCode plugin", () => {
  test("remains inert without the Mate launch environment", async () => {
    await withEnv(
      {
        MATE_ARTIFACT_PATH: undefined,
        MATE_REPO_PATH: undefined,
        MATE_REPO_ID: undefined,
        MATE_REPO_PROFILE: undefined,
        MATE_POLICY_JSON: undefined,
        MATE_GIT_AUTO_MODE: undefined,
        MATE_GUIDANCE_JSON: undefined,
      },
      async () => {
        const hooks = await MateOpenCodePlugin({} as never);

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
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_REPO_ID: "acme",
        MATE_REPO_PROFILE: "default",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_WRAPPER_BIN_PATH: "/package/wrappers/bin",
      },
      async () => {
        const hooks = (await MateOpenCodePlugin({} as never)) as Record<string, unknown>;

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

  test("fails fast for a managed session without companion guidance", async () => {
    const root = await makeTempDir("mate-opencode-aggregate-missing-");
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
        MATE_REPO_PROFILE: "default",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        await expect(MateOpenCodePlugin({} as never)).rejects.toThrow(
          "missing MATE_GUIDANCE_JSON in the launch environment",
        );
      },
    );
  });
});
