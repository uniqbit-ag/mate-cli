import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { extractPatchPaths, readContext } from "../../src/opencode";

import { registerCompanion } from "./companion";

type Hook = (event: Record<string, unknown>) => unknown;
type ToolInfo = {
  name: string;
  execute: () => Promise<{ content: string; metadata?: Record<string, string> }>;
};
type SystemPart = { type: "text"; text: string };

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const GUIDANCE_JSON = JSON.stringify({
  version: 1,
  companionGuidance:
    '<companion-policy framework="mate" priority="mandatory"><context><paths><path role="companion-repository" env="MATE_ARTIFACT_PATH">$MATE_ARTIFACT_PATH</path><path role="package-wrapper-bin" env="MATE_WRAPPER_BIN_PATH">$MATE_WRAPPER_BIN_PATH</path></paths><cli-tools><cli name="openspec" type="wrapper" invokeAs="$MATE_WRAPPER_BIN_PATH/openspec" /><cli name="graphify" type="wrapper" invokeAs="$MATE_WRAPPER_BIN_PATH/graphify" /><cli name="mate" type="global" invokeAs="mate" /></cli-tools></context><mandatory-rules><rule id="artifact-location" severity="critical">test</rule></mandatory-rules></companion-policy>',
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

async function register(directory: string) {
  const hooks = new Map<string, Hook>();
  const tools: ToolInfo[] = [];
  const recorder =
    (domain: string) =>
    async (name: string, callback: Hook): Promise<void> => {
      hooks.set(`${domain}.${name}`, callback);
    };
  const api = {
    location: { directory },
    session: { hook: recorder("session") },
    shell: { hook: recorder("shell") },
    tool: {
      transform: async (transform: (editor: { add: (tool: ToolInfo) => void }) => void) => {
        transform({ add: (tool) => tools.push(tool) });
      },
    },
  };
  await registerCompanion(api as never, readContext(process.env, directory));

  const system = async (...texts: string[]) => {
    const event = { system: texts.map((text): SystemPart => ({ type: "text", text })) };
    await hooks.get("session.context")!(event);
    return event.system.map((part) => part.text);
  };
  return { hooks, tools, system };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OpenCode companion registration", () => {
  test("exposes companion bin metadata and shell env for explicit wrapper resolution", async () => {
    const root = await makeTempDir("mate-opencode-metadata-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_VERSION: "0.14.0-test",
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_WRAPPER_BIN_PATH: "/package/wrappers/bin",
        MATE_NAME: "mate",
        PATH: "/usr/bin",
      },
      async () => {
        const { hooks, tools, system } = await register(repo);
        const pathsTool = tools.find((tool) => tool.name === "companion_paths");
        const result = await pathsTool?.execute();
        const payload = JSON.parse(result?.content ?? "{}");

        expect(payload.wrapperBinPath).toBe("/package/wrappers/bin");
        expect(result?.metadata?.wrapperBinPath).toBe("/package/wrappers/bin");

        const shell = { env: { MATE_GUIDANCE_JSON: GUIDANCE_JSON } as Record<string, string> };
        await hooks.get("shell.create.before")!(shell);

        expect(shell.env.MATE_WRAPPER_BIN_PATH).toBe("/package/wrappers/bin");
        expect(shell.env.MATE_VERSION).toBe("0.14.0-test");
        expect(shell.env.MATE_NAME).toBe("mate");
        expect(shell.env.PATH).toBe("/package/wrappers/bin:/usr/bin");
        /** The guidance payload is session-scoped and must not leak into shells. */
        expect(shell.env.MATE_GUIDANCE_JSON).toBe("");

        const [prompt] = await system("base");
        expect(prompt).toContain("/package/wrappers/bin/openspec");
        expect(prompt).toContain("<cli-tools>");
        expect(prompt).toContain('name="mate" type="global"');
      },
    );
  });

  test("activates for a companion-scoped context without a working repository", async () => {
    const root = await makeTempDir("mate-opencode-companion-only-");
    const companion = path.join(root, "companion");
    await fs.mkdir(companion, { recursive: true });

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: undefined,
        MATE_REPO_ID: undefined,
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_WRAPPER_BIN_PATH: "/package/wrappers/bin",
      },
      async () => {
        const { hooks, tools, system } = await register(companion);
        const result = await tools.find((tool) => tool.name === "companion_paths")?.execute();
        const payload = JSON.parse(result?.content ?? "{}");
        expect(payload.companionFrameworkPath).toBe(companion);
        expect(payload.repositoryPath).toBeUndefined();
        expect(payload.repositoryId).toBeUndefined();

        const shell = {
          env: { MATE_REPO_PATH: "/stale", MATE_REPO_ID: "stale" } as Record<string, string>,
        };
        await hooks.get("shell.create.before")!(shell);
        expect(shell.env.MATE_ARTIFACT_PATH).toBe(companion);
        expect(shell.env.MATE_REPO_PATH).toBeUndefined();
        expect(shell.env.MATE_REPO_ID).toBeUndefined();

        const [prompt] = await system("base");
        expect(prompt).toContain(companion);
        expect(prompt).not.toContain("MATE_REPO_PATH");
      },
    );
  });

  test("collapses the system prompt into one part and stays inert on a second load", async () => {
    const root = await makeTempDir("mate-opencode-system-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const { system } = await register(repo);

        const once = await system("base", " ", "extra");
        expect(once).toHaveLength(1);
        expect(once[0]).toStartWith("base\n\nextra\n\n<companion-policy");

        expect(await system(...once)).toEqual(once);
      },
    );
  });

  test("adds the companion guidance to compaction once", async () => {
    const root = await makeTempDir("mate-opencode-compaction-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const { hooks } = await register(repo);
        const event = { system: [{ type: "text", text: "summary" }] as SystemPart[] };

        await hooks.get("session.compaction")!(event);
        await hooks.get("session.compaction")!(event);

        expect(event.system).toHaveLength(2);
        expect(event.system[1]?.text).toContain("<companion-policy");
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
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const [prompt] = await (await register(repo)).system("base");

        expect(prompt).toContain("<agents.md>");
        expect(prompt).toContain("# Agent Instructions");
        expect(prompt).toContain("Always be nice.");
        expect(prompt).toContain("</agents.md>");
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
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const [prompt] = await (await register(repo)).system("base");

        expect(prompt).not.toContain("<agents.md>");
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
