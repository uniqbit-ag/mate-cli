import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { MATE_ENV, renderProjectionEnv, renderProjectionYaml } from "../../src/runtime";

const { default: MateOpenCodePlugin } = await import("./server");

type Hook = (event: Record<string, unknown>) => unknown;

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
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

/** Every launch variable cleared, so only a Projection Root can resolve a companion. */
const NO_LAUNCH = Object.fromEntries(Object.values(MATE_ENV).map((name) => [name, undefined]));

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

/** Records every hook and transform the plugin registers. */
function fakeApi(directory: string) {
  const hooks = new Map<string, Hook>();
  const tools: Array<{ name: string }> = [];
  const recorder =
    (domain: string) =>
    async (name: string, callback: Hook): Promise<void> => {
      hooks.set(`${domain}.${name}`, callback);
    };
  const api = {
    location: { directory },
    permission: { hook: recorder("permission") },
    skill: { transform: async () => {} },
    tool: {
      hook: recorder("tool"),
      transform: async (transform: (editor: { add: (tool: { name: string }) => void }) => void) => {
        transform({ add: (tool) => tools.push(tool) });
      },
    },
    session: { hook: recorder("session"), prompt: async () => undefined },
    shell: { hook: recorder("shell") },
    event: {
      subscribe: async function* () {
        await new Promise(() => {});
      },
    },
  };
  return { api: api as never, hooks, tools };
}

async function wrappedRepo(companionPath: string): Promise<string> {
  const repoRoot = await makeTempDir("mate-server-wrapped-");
  const mateDir = path.join(repoRoot, ".mate");
  await fs.mkdir(path.join(mateDir, "config"), { recursive: true });
  await fs.writeFile(path.join(mateDir, "config", "registry.yaml"), "companions: []\n", "utf8");
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
  await fs.writeFile(path.join(mateDir, "projection.yaml"), renderProjectionYaml(file), "utf8");
  await fs.writeFile(path.join(mateDir, "projection.env"), renderProjectionEnv(file), "utf8");
  return repoRoot;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Mate OpenCode server plugin", () => {
  test("exports an OpenCode 2.x definition only", () => {
    expect(MateOpenCodePlugin.id).toBe("mate-opencode-plugin");
    expect(MateOpenCodePlugin.setup).toBeFunction();
    expect(Object.keys(MateOpenCodePlugin).sort()).toEqual(["id", "setup"]);
  });

  test("remains inert outside a managed session and any wrapped repository", async () => {
    const outside = await makeTempDir("mate-inert-");
    const { api, hooks, tools } = fakeApi(outside);

    const cleanup = await withEnv(NO_LAUNCH, async () => MateOpenCodePlugin.setup(api));

    expect(cleanup).toBeUndefined();
    expect(hooks.size).toBe(0);
    expect(tools).toEqual([]);
  });

  test("registers all Mate behavior for a managed session", async () => {
    const root = await makeTempDir("mate-opencode-aggregate-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        ...NO_LAUNCH,
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_REPO_ID: "acme",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_WRAPPER_BIN_PATH: "/package/wrappers/bin",
      },
      async () => {
        const { api, hooks, tools } = fakeApi(repo);
        await MateOpenCodePlugin.setup(api);

        expect([...hooks.keys()].sort()).toEqual([
          "permission.evaluate",
          "session.compaction",
          "session.context",
          "shell.create.before",
          "tool.execute.before",
        ]);
        expect(tools.map((tool) => tool.name)).toEqual(["companion_paths"]);

        const event = { system: [{ type: "text", text: "base prompt" }] };
        await hooks.get("session.context")!(event);
        expect(event.system).toHaveLength(1);
        expect(event.system[0]?.text).toContain("base prompt");
        expect(event.system[0]?.text).toContain("<companion-policy ");
        expect(event.system[0]?.text).toContain(companion);
      },
    );
  });

  test("returns a cleanup for the React Doctor subscription", async () => {
    const root = await makeTempDir("mate-opencode-react-doctor-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });

    await withEnv(
      {
        ...NO_LAUNCH,
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_REPO_ID: "acme",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_REACT_DOCTOR_ENABLED: "1",
      },
      async () => {
        const { api, hooks } = fakeApi(repo);
        const cleanup = await MateOpenCodePlugin.setup(api);

        expect(hooks.has("tool.execute.after")).toBe(true);
        expect(cleanup).toBeFunction();
        await cleanup?.();
      },
    );
  });

  test("resolves the companion from the session directory's Projection Root", async () => {
    const companion = await makeTempDir("mate-projected-companion-");
    const repo = await wrappedRepo(companion);

    await withEnv(NO_LAUNCH, async () => {
      const { api, hooks } = fakeApi(repo);
      await MateOpenCodePlugin.setup(api);

      const event = { resources: [path.join(companion, "notes.md")], effect: "ask" };
      await hooks.get("permission.evaluate")!(event);
      expect(event.effect).toBe("allow");
      expect(hooks.has("session.context")).toBe(true);
    });
  });

  test("the launch environment outranks the projection", async () => {
    const projected = await makeTempDir("mate-projected-companion-");
    const launched = await makeTempDir("mate-launched-companion-");
    const repo = await wrappedRepo(projected);

    await withEnv(
      {
        ...NO_LAUNCH,
        MATE_ARTIFACT_PATH: launched,
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const { api, hooks } = fakeApi(repo);
        await MateOpenCodePlugin.setup(api);
        const evaluate = hooks.get("permission.evaluate")!;

        const inLaunched = { resources: [path.join(launched, "a.md")], effect: "ask" };
        const inProjected = { resources: [path.join(projected, "a.md")], effect: "ask" };
        await evaluate(inLaunched);
        await evaluate(inProjected);
        expect(inLaunched.effect).toBe("allow");
        expect(inProjected.effect).toBe("ask");
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
        ...NO_LAUNCH,
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "acme",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        await expect(MateOpenCodePlugin.setup(fakeApi(repo).api)).rejects.toThrow(
          "missing MATE_GUIDANCE_JSON in the launch environment",
        );
      },
    );
  });
});
