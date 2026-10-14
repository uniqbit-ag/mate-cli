import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { MATE_ENV, renderProjectionEnv, renderProjectionYaml } from "../../src/runtime";
import { audienceLayerDir } from "../../src/runtime/audience-layer";
import { runtimeMateBin, runtimeWrapperBinPath } from "../../src/runtime/runtime-directory";
import {
  EMPTY_MANIFEST,
  manifestPath,
  OPENCODE_CONFIG_DOCUMENT,
  serializeManifest,
  withAudience,
  withDocument,
} from "../../src/runtime/runtime-document-manifest";

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
  const applied = {
    mcp: new Map<string, unknown>(),
    skills: [] as Array<{ id: string; content: string }>,
    agents: new Map<string, Record<string, unknown>>(),
  };
  const api = {
    location: { directory },
    permission: { hook: recorder("permission") },
    skill: {
      transform: async (
        transform: (editor: {
          get: (id: string) => undefined;
          add: (skill: { id: string; content: string }) => void;
          update: () => void;
        }) => void,
      ) => {
        transform({
          get: () => undefined,
          add: (skill) => applied.skills.push(skill),
          update: () => {},
        });
      },
    },
    mcp: {
      transform: async (
        transform: (editor: { set: (name: string, config: unknown) => void }) => void,
      ) => {
        transform({ set: (name, config) => applied.mcp.set(name, config) });
      },
    },
    agent: {
      transform: async (
        transform: (editor: {
          get: (id: string) => Record<string, unknown> | undefined;
          update: (id: string, update: (agent: Record<string, unknown>) => void) => void;
        }) => void,
      ) => {
        transform({
          get: (id) => applied.agents.get(id),
          update: (id, update) => {
            const agent = applied.agents.get(id) ?? {};
            update(agent);
            applied.agents.set(id, agent);
          },
        });
      },
    },
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
  return { api: api as never, hooks, tools, applied };
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

/** What any `mate` run leaves behind; the plugin resolves wrapper paths through it. */
beforeEach(async () => {
  await fs.mkdir(runtimeWrapperBinPath(), { recursive: true });
});

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
    await fs.mkdir(path.dirname(runtimeMateBin()), { recursive: true });
    await fs.writeFile(
      runtimeMateBin(),
      `#!/bin/sh\necho '{"ok":true,"steps":[],"warnings":[]}'\n`,
      { mode: 0o755 },
    );
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
      const argsFile = path.join(companion, "prepare-args");
      await fs.mkdir(path.dirname(runtimeMateBin()), { recursive: true });
      await fs.writeFile(
        runtimeMateBin(),
        `#!/bin/sh\necho "$@" >> '${argsFile}'\necho '{"ok":true,"steps":[],"warnings":[]}'\n`,
        { mode: 0o755 },
      );
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
      const deadline = Date.now() + 5_000;
      let lines: string[] = [];
      while (lines.length < 2 && Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop -- waits for the detached sync
        await new Promise((resolve) => setTimeout(resolve, 20));
        // oxlint-disable-next-line no-await-in-loop
        lines = (await fs.readFile(argsFile, "utf8").catch(() => "")).trim().split("\n");
      }
      expect(lines[0]).toEndWith("--json");
      expect(lines[1]).toEndWith("--json --sync");
    },
  );
});

describe("the audience layer", () => {
  /** A layer as the OpenCode Runtime Surface writes it. */
  async function makeLayer(): Promise<string> {
    const layer = await makeTempDir("mate-layer-");
    await fs.mkdir(path.join(layer, ".opencode", "agents"), { recursive: true });
    await fs.mkdir(path.join(layer, ".agents", "skills", "ba-skill"), { recursive: true });
    await fs.writeFile(
      path.join(layer, ".opencode", "opencode.json"),
      JSON.stringify({ mcp: { servers: { "ba-mcp": { type: "local", command: ["ba"] } } } }),
      "utf8",
    );
    await fs.writeFile(
      path.join(layer, ".agents", "skills", "ba-skill", "SKILL.md"),
      "---\nname: ba-skill\ndescription: ba skill\n---\nBA skill body.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(layer, ".opencode", "agents", "analyst.md"),
      "---\ndescription: BA analyst\nmode: primary\n---\nYou are the BA analyst.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(layer, "AGENTS.md"),
      "<!-- mate:managed:ba-plugin:abc123 start -->\nBA guidance.\n<!-- mate:managed:ba-plugin:abc123 end -->\n",
      "utf8",
    );
    return layer;
  }

  async function launch(payload: string, argv?: string[]) {
    const root = await makeTempDir("mate-opencode-layer-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    const previousArgv = process.argv;
    if (argv) process.argv = argv;
    try {
      return await withEnv(
        {
          ...NO_LAUNCH,
          MATE_ARTIFACT_PATH: companion,
          MATE_REPO_PATH: repo,
          MATE_GUIDANCE_JSON: payload,
          MATE_REPO_ID: "acme",
          MATE_POLICY_JSON: "{}",
          MATE_GIT_AUTO_MODE: "0",
        },
        async () => {
          const fake = fakeApi(repo);
          await MateOpenCodePlugin.setup(fake.api);
          return fake;
        },
      );
    } finally {
      process.argv = previousArgv;
    }
  }

  function payloadWith(layer: string): string {
    return JSON.stringify({ ...JSON.parse(GUIDANCE_JSON), audienceLayer: layer });
  }

  test("a trusted payload applies the layer's MCP servers, skills, agents and guidance", async () => {
    const layer = await makeLayer();

    const { applied, hooks } = await launch(payloadWith(layer));

    expect(applied.mcp.get("ba-mcp")).toEqual({ type: "local", command: ["ba"] });
    expect(applied.skills.map((skill) => skill.id)).toEqual(["ba-skill"]);
    expect(applied.agents.get("analyst")).toMatchObject({
      description: "BA analyst",
      mode: "primary",
      system: "You are the BA analyst.",
    });

    const event = { system: [{ type: "text", text: "base prompt" }] };
    await hooks.get("session.context")!(event);
    const text = event.system[0]!.text;
    expect(text).toContain("BA guidance.");
    expect(text).not.toContain("mate:managed");
    expect(text.indexOf("BA guidance.")).toBeGreaterThan(text.indexOf("<companion-policy "));

    const access = {
      resources: [path.join(layer, ".agents", "skills", "ba-skill", "x.sh")],
      effect: "ask",
    };
    await hooks.get("permission.evaluate")!(access);
    expect(access.effect).toBe("allow");
  });

  test("a masked payload applies no layer", async () => {
    await makeLayer();

    const { applied, hooks } = await launch("");

    expect(applied.mcp.size).toBe(0);
    expect(applied.agents.size).toBe(0);
    expect(hooks.has("session.context")).toBe(false);
  });

  test("the shared service applies no layer, whatever payload it inherited", async () => {
    const layer = await makeLayer();

    const { applied } = await launch(payloadWith(layer), ["opencode", "serve", "--service"]);

    expect(applied.mcp.size).toBe(0);
    expect(applied.skills).toEqual([]);
    expect(applied.agents.size).toBe(0);
  });
});

describe("a checkout wrapped for an audience", () => {
  /** Wraps a repository for `audience` (or base) and renders `ba` and `qa` layers for its companion. */
  async function wrappedFor(audience: string | null) {
    const companion = await makeTempDir("mate-wrapped-audience-companion-");
    const repo = await wrappedRepo(companion);
    const manifest = withAudience(
      withDocument(EMPTY_MANIFEST, OPENCODE_CONFIG_DOCUMENT, []),
      audience,
    );
    await fs.writeFile(manifestPath(repo), serializeManifest(manifest) ?? "", "utf8");
    for (const name of ["ba", "qa"]) {
      const dir = audienceLayerDir(companion, name);
      const version = path.join(dir, "f1");
      await fs.mkdir(path.join(version, ".opencode"), { recursive: true });
      await fs.writeFile(
        path.join(version, ".opencode", "opencode.json"),
        JSON.stringify({
          mcp: { servers: { [`${name}-mcp`]: { type: "local", command: [name] } } },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(version, "AGENTS.md"), `Guidance for ${name}.\n`, "utf8");
      await fs.rm(path.join(dir, "current"), { force: true });
      await fs.symlink("f1", path.join(dir, "current"));
      tempRoots.push(dir);
    }
    return { repo };
  }

  async function setupIn(repo: string, env: Record<string, string | undefined>, argv?: string[]) {
    const previousArgv = process.argv;
    if (argv) process.argv = argv;
    try {
      return await withEnv({ ...NO_LAUNCH, ...env }, async () => {
        const fake = fakeApi(repo);
        await MateOpenCodePlugin.setup(fake.api);
        return fake;
      });
    } finally {
      process.argv = previousArgv;
    }
  }

  test("a bare session gets the wrapped audience, never the one in its environment", async () => {
    const { repo } = await wrappedFor("ba");

    const { applied, hooks } = await setupIn(repo, { MATE_AUDIENCE: "qa" });

    expect([...applied.mcp.keys()]).toEqual(["ba-mcp"]);
    const event = { system: [{ type: "text", text: "base prompt" }] };
    await hooks.get("session.context")!(event);
    expect(event.system[0]!.text).toContain("Guidance for ba.");
    expect(event.system[0]!.text).not.toContain("Guidance for qa.");
  });

  test("the shared service serves a wrapped checkout its audience", async () => {
    const { repo } = await wrappedFor("ba");

    const { applied } = await setupIn(repo, {}, ["opencode", "serve", "--service"]);

    expect([...applied.mcp.keys()]).toEqual(["ba-mcp"]);
  });

  test("a checkout wrapped for base gets no layer", async () => {
    const { repo } = await wrappedFor(null);

    const { applied } = await setupIn(repo, { MATE_AUDIENCE: "ba" });

    expect(applied.mcp.size).toBe(0);
  });
});
