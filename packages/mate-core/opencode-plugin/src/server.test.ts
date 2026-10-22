import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createTempDir, overrideEnv, withEnv } from "../../../../test/fixtures";
import { MATE_ENV, renderProjectionEnv, renderProjectionYaml } from "../../src/runtime";
import { runtimeMateBin, runtimeWrapperBinPath } from "../../src/runtime/runtime-directory";

const { default: MateOpenCodePlugin } = await import("./server");

type Hook = (event: Record<string, unknown>) => unknown;

const tempRoots: string[] = [];
let restoreEnvironment: () => void;
let prepareArgsFile: string;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  tempRoots.push(dir);
  return dir;
}

/**
 * Replaces the stub by rename, never in place: a detached sync an earlier test
 * started may still be reading the old script, and a shell reads its script as
 * it runs, so rewriting the file would run the new stub with the old arguments.
 */
async function writeMateStub(script: string): Promise<void> {
  const bin = runtimeMateBin();
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const staged = `${bin}.${process.pid}.tmp`;
  await fs.writeFile(staged, script, { mode: 0o755 });
  await fs.rename(staged, bin);
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

/** Each test owns its launcher; detached syncs may outlive setup. */
beforeEach(async () => {
  restoreEnvironment = overrideEnv({ HOME: await makeTempDir("acme-server-home-") });
  prepareArgsFile = path.join(path.dirname(runtimeMateBin()), "prepare-args");
  await fs.mkdir(runtimeWrapperBinPath(), { recursive: true });
});

afterEach(async () => {
  try {
    await finishedPrepareArguments();
  } finally {
    restoreEnvironment();
    await Promise.all(
      tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  }
});

async function writePrepareLauncher(): Promise<void> {
  const quotedArgsFile = `'${prepareArgsFile.replaceAll("'", "'\\''")}'`;
  await writeMateStub(
    `#!/bin/sh\necho '{"ok":true,"steps":[],"warnings":[]}'\necho "$@" >> ${quotedArgsFile}\n`,
  );
}

/** The launcher records its sync after its last use of fixture files. */
async function finishedPrepareArguments(): Promise<string[]> {
  const read = async () =>
    (await fs.readFile(prepareArgsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  let lines = await read();
  if (lines.length === 0) return lines;
  const deadline = Date.now() + 5_000;
  while (!lines.some((line) => line.endsWith("--sync")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    lines = await read();
  }
  if (!lines.some((line) => line.endsWith("--sync")))
    throw new Error("The fixture's detached prepare did not finish.");
  return lines;
}

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

  test("registers no post-edit hook with React Doctor enabled", async () => {
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

        expect(hooks.has("tool.execute.after")).toBe(false);
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

  test("a malformed payload in a managed launch is still fatal", async () => {
    const companion = await makeTempDir("mate-opencode-malformed-");
    const repo = await makeTempDir("mate-opencode-malformed-repo-");

    await withEnv(
      {
        ...NO_LAUNCH,
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "acme",
        MATE_GUIDANCE_JSON: "{",
      },
      async () => {
        await expect(MateOpenCodePlugin.setup(fakeApi(repo).api)).rejects.toThrow(
          "Mate OpenCode companion plugin is incomplete",
        );
      },
    );
  });
});

/** What a shell under another repository's Mate session exports, minus the payload. */
async function inheritedFrom(): Promise<Record<string, string | undefined>> {
  const other = await makeTempDir("mate-inherited-other-");
  return {
    ...NO_LAUNCH,
    MATE_REPO_PATH: path.join(other, "repo"),
    MATE_ARTIFACT_PATH: path.join(other, "companion"),
    MATE_REPO_ID: "other",
    MATE_POLICY_JSON: "{}",
    MATE_WRAPPER_BIN_PATH: path.join(other, "wrappers", "bin"),
    MATE_GIT_AUTO_MODE: "0",
  };
}

function withArgv<T>(argv: string[], fn: () => Promise<T>): Promise<T> {
  const previous = process.argv;
  process.argv = argv;
  return fn().finally(() => {
    process.argv = previous;
  });
}

describe("an inherited environment", () => {
  test("in a service started from another repository's session resolves from the projection", async () => {
    const companion = await makeTempDir("mate-projected-companion-");
    const repo = await wrappedRepo(companion);
    const inherited = await inheritedFrom();

    await withEnv(inherited, async () => {
      const { api, hooks, tools } = fakeApi(repo);
      await MateOpenCodePlugin.setup(api);

      const paths = tools.find((tool) => tool.name === "companion_paths") as unknown as {
        execute: () => Promise<{ content: string }>;
      };
      const result = JSON.parse((await paths.execute()).content);
      expect(result.companionFrameworkPath).toBe(companion);
      expect(result.repositoryPath).toBe(repo);
      expect(result.repositoryId).toBe("acme");

      const event = { system: [{ type: "text", text: "base" }] };
      await hooks.get("session.context")!(event);
      expect(event.system[0]?.text).toContain(companion);
      expect(event.system[0]?.text).not.toContain(inherited.MATE_ARTIFACT_PATH!);

      const shell = { env: { ...inherited } as Record<string, string | undefined> };
      await hooks.get("shell.create.before")!(shell);
      expect(shell.env.MATE_ARTIFACT_PATH).toBe(companion);
      expect(shell.env.MATE_REPO_PATH).toBe(repo);
      expect(shell.env.MATE_REPO_ID).toBe("acme");
      expect(shell.env.MATE_WRAPPER_BIN_PATH).not.toBe(inherited.MATE_WRAPPER_BIN_PATH);
    });
  });

  test("in an unwrapped location stays inert without an error", async () => {
    const outside = await makeTempDir("mate-inherited-inert-");
    const { api, hooks, tools } = fakeApi(outside);

    const cleanup = await withEnv(await inheritedFrom(), async () => MateOpenCodePlugin.setup(api));

    expect(cleanup).toBeUndefined();
    expect(hooks.size).toBe(0);
    expect(tools).toEqual([]);
  });

  test("the shared service ignores even a guidance payload", async () => {
    const projected = await makeTempDir("mate-projected-companion-");
    const launched = await makeTempDir("mate-launched-companion-");
    const repo = await wrappedRepo(projected);

    await withArgv(["bun", "/$bunfs/root/opencode", "serve", "--service"], () =>
      withEnv(
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
          expect(inProjected.effect).toBe("allow");
          expect(inLaunched.effect).toBe("ask");
        },
      ),
    );
  });
});

describe("the session-prepare lifecycle", () => {
  function withMcp(api: Record<string, unknown>) {
    const calls: string[] = [];
    Object.assign(api, {
      mcp: {
        transform: async () => {
          calls.push("transform");
          return { dispose: async () => {} };
        },
        reload: async () => {
          calls.push("reload");
        },
      },
    });
    return calls;
  }

  test("a projected but not OpenCode-wrapped location registers no prepare or MCP gating", async () => {
    const companion = await makeTempDir("mate-prepare-companion-");
    const repo = await wrappedRepo(companion);
    const { api } = fakeApi(repo);
    const calls = withMcp(api as unknown as Record<string, unknown>);

    await withEnv(NO_LAUNCH, async () => MateOpenCodePlugin.setup(api));

    expect(calls).toEqual([]);
  });

  test("an OpenCode-wrapped location without a runtime launcher says to run mate", async () => {
    const companion = await makeTempDir("mate-prepare-companion-");
    const repo = await wrappedRepo(companion);
    await fs.writeFile(
      path.join(repo, ".mate", "runtime-documents.json"),
      JSON.stringify({ documents: { ".opencode/opencode.json": [] } }),
    );
    const { api } = fakeApi(repo);
    const calls = withMcp(api as unknown as Record<string, unknown>);
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });

    try {
      await withEnv(NO_LAUNCH, async () => MateOpenCodePlugin.setup(api));
    } finally {
      spy.mockRestore();
    }

    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("run `mate` once");
  });

  async function openCodeWrappedRepo(companion: string): Promise<string> {
    const repo = await wrappedRepo(companion);
    await fs.writeFile(
      path.join(repo, ".mate", "runtime-documents.json"),
      JSON.stringify({
        documents: {
          ".opencode/opencode.json": [
            { kind: "map", at: ["mcp", "servers"], entries: { tokensave: {} } },
          ],
        },
      }),
    );
    await writePrepareLauncher();
    return repo;
  }

  test.skipIf(process.platform === "win32")(
    "a masked payload is not a managed launch and prepares from the projection",
    async () => {
      const companion = await makeTempDir("mate-prepare-companion-");
      const repo = await openCodeWrappedRepo(companion);
      const { api } = fakeApi(repo);
      const calls = withMcp(api as unknown as Record<string, unknown>);

      const cleanup = await withEnv(
        {
          ...NO_LAUNCH,
          MATE_ARTIFACT_PATH: path.join(repo, "elsewhere"),
          MATE_REPO_PATH: repo,
          MATE_GUIDANCE_JSON: "",
        },
        async () => MateOpenCodePlugin.setup(api),
      );
      await (cleanup as (() => Promise<void>) | undefined)?.();

      expect(calls).toEqual(["transform", "reload"]);
    },
  );

  test("a managed launch stays env-first and registers no prepare", async () => {
    const projected = await makeTempDir("mate-prepare-companion-");
    const launched = await makeTempDir("mate-launched-companion-");
    const repo = await openCodeWrappedRepo(projected);
    const { api, hooks } = fakeApi(repo);
    const calls = withMcp(api as unknown as Record<string, unknown>);

    await withEnv(
      {
        ...NO_LAUNCH,
        MATE_ARTIFACT_PATH: launched,
        MATE_GUIDANCE_JSON: GUIDANCE_JSON,
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => MateOpenCodePlugin.setup(api),
    );

    const inLaunched = { resources: [path.join(launched, "a.md")], effect: "ask" };
    await hooks.get("permission.evaluate")!(inLaunched);
    expect(inLaunched.effect).toBe("allow");
    expect(calls).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "registers the guardrails first, awaits the local prepare, then starts the sync",
    async () => {
      const companion = await makeTempDir("mate-prepare-companion-");
      const repo = await wrappedRepo(companion);
      await fs.writeFile(
        path.join(repo, ".mate", "runtime-documents.json"),
        JSON.stringify({
          documents: {
            ".opencode/opencode.json": [
              { kind: "map", at: ["mcp", "servers"], entries: { tokensave: {} } },
            ],
          },
        }),
      );
      await writePrepareLauncher();
      const { api, hooks } = fakeApi(repo);
      const calls = withMcp(api as unknown as Record<string, unknown>);
      let hooksAtGate = -1;
      const mcp = (api as unknown as { mcp: { transform: (...args: unknown[]) => unknown } }).mcp;
      const transform = mcp.transform;
      mcp.transform = (...args: unknown[]) => {
        hooksAtGate = hooks.size;
        return transform(...args);
      };

      const cleanup = await withEnv(NO_LAUNCH, async () => MateOpenCodePlugin.setup(api));
      await (cleanup as (() => Promise<void>) | undefined)?.();

      expect(hooksAtGate).toBeGreaterThan(0);
      expect(hooksAtGate).toBe(hooks.size);
      expect(calls).toEqual(["transform", "reload"]);
      const lines = await finishedPrepareArguments();
      expect(lines).toEqual([
        `session prepare --repo ${repo} --json`,
        `session prepare --repo ${repo} --json --sync`,
      ]);
    },
  );
});
