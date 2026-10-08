import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ApplianceConfig } from "./config";
import {
  assertCompanionsDirUsable,
  checkoutConfigured,
  discoverCompanions,
  type RunResult,
  type Runner,
  sameRemote,
  selectCompanion,
  StartupError,
} from "./discovery";
import {
  assertRequirementsCarried,
  parsePluginCapabilities,
  prepareStartup,
  readCompanionSelections,
  renderCredentials,
  renderPlan,
  type StartupDeps,
} from "./startup";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-appliance-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const FRAMEWORK = `type: companion
allowedAgents:
  - opencode
packageManagers:
  - bun
capabilities:
  - name: openspec
`;

function makeCompanion(directory: string, framework = FRAMEWORK): string {
  fs.mkdirSync(path.join(directory, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".mate", "config", "framework.yaml"), framework);
  return directory;
}

function recorder(responses: Record<string, RunResult> = {}): {
  run: Runner;
  calls: string[][];
  envs: Array<Record<string, string> | undefined>;
} {
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const run: Runner = (command, args, _cwd, env) => {
    calls.push([command, ...args]);
    envs.push(env);
    const key = [command, ...args].join(" ");
    for (const [match, response] of Object.entries(responses)) {
      if (key.includes(match)) return response;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls, envs };
}

function deps(overrides: Partial<StartupDeps> = {}): StartupDeps {
  return {
    run: recorder().run,
    mate: "mate",
    prebuilt: "/opt/mate/prebuilt",
    setupScript: "/opt/mate/tools/startup/setup.sh",
    identity: "mate (uid 10001)",
    onPath: () => true,
    log: () => {},
    ...overrides,
  };
}

function config(overrides: Partial<ApplianceConfig> = {}): ApplianceConfig {
  return {
    companionsDir: root,
    companionRepos: [],
    companion: null,
    audience: null,
    studioPort: 4097,
    studioHost: "0.0.0.0",
    studioWritable: true,
    studioTerminal: true,
    studioDetachMinutes: 30,
    studioToken: null,
    studioAllowedHosts: [],
    studioPublicOrigin: null,
    gitSync: false,
    gitUserName: null,
    gitUserEmail: null,
    credentials: {},
    pluginRegistry: null,
    gitCloneToken: null,
    setupHint: null,
    removed: [],
    ...overrides,
  };
}

/** Permission bits do not constrain root, so those two cases cannot be posed to it. */
const asUnprivilegedUser = process.getuid?.() === 0 ? test.skip : test;

describe("the companions directory", () => {
  asUnprivilegedUser("an unreadable directory is reported by name and by identity", () => {
    const denied = path.join(root, "denied");
    fs.mkdirSync(denied);
    fs.chmodSync(denied, 0o000);
    try {
      expect(() => assertCompanionsDirUsable(denied, "mate (uid 10001)")).toThrow(
        /denied.*mate \(uid 10001\)/s,
      );
    } finally {
      fs.chmodSync(denied, 0o755);
    }
  });

  asUnprivilegedUser("an unwritable directory is reported by name and by identity", () => {
    const readonly = path.join(root, "readonly");
    fs.mkdirSync(readonly);
    fs.chmodSync(readonly, 0o555);
    try {
      expect(() => assertCompanionsDirUsable(readonly, "mate (uid 10001)")).toThrow(
        /readonly.*not writable.*mate \(uid 10001\)/s,
      );
    } finally {
      fs.chmodSync(readonly, 0o755);
    }
  });

  test("a missing directory is reported rather than created", () => {
    const missing = path.join(root, "missing");
    expect(() => assertCompanionsDirUsable(missing, "mate")).toThrow(/does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe("checking out configured Git locations", () => {
  test("a location is cloned when its destination is empty", () => {
    const { run, calls } = recorder();
    const outcomes = checkoutConfigured(
      root,
      [{ url: "https://example.com/acme.git", directory: "acme" }],
      run,
    );
    expect(outcomes[0]!.cloned).toBe(true);
    expect(calls).toEqual([
      ["git", "clone", "https://example.com/acme.git", path.join(root, "acme")],
    ]);
  });

  test("an existing checkout is neither re-cloned nor reset", () => {
    const destination = makeCompanion(path.join(root, "acme"));
    fs.writeFileSync(path.join(destination, "NOTES.md"), "mine\n");
    const { run, calls } = recorder({
      "remote get-url": { status: 0, stdout: "https://example.com/acme.git\n", stderr: "" },
    });

    const outcomes = checkoutConfigured(
      root,
      [{ url: "https://example.com/acme.git", directory: "acme" }],
      run,
    );

    expect(outcomes[0]!.cloned).toBe(false);
    expect(calls.some((call) => call.includes("clone") || call.includes("reset"))).toBe(false);
    expect(fs.readFileSync(path.join(destination, "NOTES.md"), "utf8")).toBe("mine\n");
  });

  test("a checkout from a different remote is reported naming both, and left intact", () => {
    const destination = makeCompanion(path.join(root, "acme"));
    fs.writeFileSync(path.join(destination, "NOTES.md"), "mine\n");
    const { run } = recorder({
      "remote get-url": { status: 0, stdout: "https://example.com/other.git\n", stderr: "" },
    });

    expect(() =>
      checkoutConfigured(root, [{ url: "https://example.com/acme.git", directory: "acme" }], run),
    ).toThrow(/other\.git.*acme\.git/s);
    expect(fs.readFileSync(path.join(destination, "NOTES.md"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(destination, ".mate", "config", "framework.yaml"))).toBe(true);
  });

  test("two spellings of the same remote are not a conflict", () => {
    expect(sameRemote("git@example.com:org/acme.git", "https://example.com/org/acme")).toBe(true);
    expect(sameRemote("https://example.com/a.git", "https://example.com/b.git")).toBe(false);
  });

  test("a clone token reaches only the child's environment, never arguments or the URL", () => {
    const { run, calls, envs } = recorder();
    checkoutConfigured(
      root,
      [{ url: "https://example.com/acme.git", directory: "acme" }],
      run,
      "tok-123",
    );
    expect(JSON.stringify(calls)).not.toContain("tok-123");
    expect(envs[envs.length - 1]).toMatchObject({ MATE_GIT_CLONE_TOKEN: "tok-123" });
    expect(calls[calls.length - 1]).toContain("https://example.com/acme.git");
    expect(calls[calls.length - 1]!.slice(0, 2)).toEqual(["git", "-c"]);
    expect(calls[calls.length - 1]!.indexOf("clone")).toBeGreaterThan(
      calls[calls.length - 1]!.lastIndexOf("-c"),
    );
  });

  test("a rejected clone token is redacted from the failure", () => {
    const { run } = recorder({
      clone: { status: 128, stdout: "", stderr: "fatal: auth failed for tok-123\n" },
    });
    let message = "";
    try {
      checkoutConfigured(
        root,
        [{ url: "https://example.com/gone.git", directory: "gone" }],
        run,
        "tok-123",
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("auth failed");
    expect(message).not.toContain("tok-123");
  });

  test("a failed clone names the location and the reason", () => {
    const { run } = recorder({
      clone: { status: 128, stdout: "", stderr: "fatal: repository not found\n" },
    });
    expect(() =>
      checkoutConfigured(root, [{ url: "https://example.com/gone.git", directory: "gone" }], run),
    ).toThrow(/gone\.git.*repository not found/s);
  });
});

describe("discovery and selection", () => {
  test("no companion at all is a startup failure", () => {
    expect(discoverCompanions(root)).toEqual([]);
    expect(() => selectCompanion([], null)).toThrow(/No Companion Repository/);
  });

  test("one companion is found and needs no selection", () => {
    makeCompanion(path.join(root, "acme"));
    const found = discoverCompanions(root);
    expect(found).toEqual([path.resolve(root, "acme")]);
    expect(selectCompanion(found, null)).toBe(path.resolve(root, "acme"));
  });

  test("several companions are found and the named one is used", () => {
    makeCompanion(path.join(root, "acme"));
    makeCompanion(path.join(root, "beta"));
    const found = discoverCompanions(root);
    expect(found).toHaveLength(2);
    expect(selectCompanion(found, "beta")).toBe(path.resolve(root, "beta"));
    expect(selectCompanion(found, path.resolve(root, "acme"))).toBe(path.resolve(root, "acme"));
  });

  test("an unnamed selection among several lists the candidates rather than choosing", () => {
    makeCompanion(path.join(root, "acme"));
    makeCompanion(path.join(root, "beta"));
    const found = discoverCompanions(root);
    expect(() => selectCompanion(found, null)).toThrow(/acme, beta/);
  });

  test("a named companion that was not found is reported", () => {
    makeCompanion(path.join(root, "acme"));
    expect(() => selectCompanion(discoverCompanions(root), "missing")).toThrow(/missing/);
  });

  test("a directory carrying no companion configuration is not a companion", () => {
    fs.mkdirSync(path.join(root, "notes"));
    expect(discoverCompanions(root)).toEqual([]);
  });
});

describe("requirements the image carries", () => {
  test("a companion's selections are read from its own configuration", () => {
    const companion = makeCompanion(path.join(root, "acme"));
    expect(readCompanionSelections(companion)).toEqual({
      packageManagers: ["bun"],
      capabilities: ["openspec"],
    });
  });

  test("a fully loaded companion passes", () => {
    expect(() =>
      assertRequirementsCarried(
        {
          packageManagers: ["bun", "uv"],
          capabilities: [
            "openspec",
            "graphify",
            "rtk",
            "tokensave",
            "context-mode",
            "react-doctor",
            "context7",
          ],
        },
        () => true,
      ),
    ).not.toThrow();
  });

  test("a capability outside the supported set is named", () => {
    expect(() =>
      assertRequirementsCarried(
        { packageManagers: ["bun"], capabilities: ["astrology"] },
        () => true,
      ),
    ).toThrow(/astrology/);
  });

  test("a supported capability whose command is absent is named", () => {
    expect(() =>
      assertRequirementsCarried(
        { packageManagers: ["bun"], capabilities: ["graphify"] },
        (command) => command !== "graphify",
      ),
    ).toThrow(/graphify/);
  });

  test("the refusal says nothing was installed to repair it", () => {
    expect(() =>
      assertRequirementsCarried({ packageManagers: ["pnpm"], capabilities: [] }, () => true),
    ).toThrow(/Nothing was installed/);
  });
});

describe("startup as a whole", () => {
  test("registers every discovered companion and prepares only the selected one", () => {
    makeCompanion(path.join(root, "acme"));
    makeCompanion(path.join(root, "beta"));
    const { run, calls } = recorder();

    const plan = prepareStartup(config({ companion: "beta" }), deps({ run }));

    expect(plan.companion).toBe(path.resolve(root, "beta"));
    const registered = calls
      .filter((call) => call[1] === "companion" && call[2] === "register")
      .map((call) => call[3]);
    expect(registered.sort()).toEqual([path.resolve(root, "acme"), path.resolve(root, "beta")]);

    const prepared = calls.filter((call) => call[2] === "prepare");
    expect(prepared).toEqual([
      ["mate", "companion", "prepare", "--from", "/opt/mate/prebuilt", path.resolve(root, "beta")],
    ]);
  });

  test("registration leaves the companion's configuration byte-identical", () => {
    const companion = makeCompanion(path.join(root, "acme"));
    const file = path.join(companion, ".mate", "config", "framework.yaml");
    const before = fs.readFileSync(file);

    prepareStartup(config(), deps());

    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  test("a failed registration stops startup before anything is prepared", () => {
    makeCompanion(path.join(root, "acme"));
    const { run, calls } = recorder({
      register: { status: 1, stdout: "", stderr: "nothing to register\n" },
    });

    expect(() => prepareStartup(config(), deps({ run }))).toThrow(/nothing to register/);
    expect(calls.some((call) => call.includes("prepare"))).toBe(false);
  });

  test("a missing or incompatible dependency is reported by name and nothing is served", () => {
    makeCompanion(path.join(root, "acme"));
    const { run } = recorder({
      prepare: {
        status: 1,
        stdout: "",
        stderr: "context-mode: expected 1.0.169 installed; found 1.0.168.\n",
      },
    });

    expect(() => prepareStartup(config(), deps({ run }))).toThrow(/context-mode/);
  });

  test("an unsatisfiable requirement stops startup before preparation is attempted", () => {
    makeCompanion(
      path.join(root, "acme"),
      "type: companion\npackageManagers:\n  - bun\ncapabilities:\n  - name: rtk\n",
    );
    const { run, calls } = recorder();

    expect(() =>
      prepareStartup(config(), deps({ run, onPath: (command) => command !== "rtk" })),
    ).toThrow(/rtk/);
    expect(calls.some((call) => call.includes("prepare"))).toBe(false);
  });
});

describe("what startup hands the supervisor", () => {
  test("the plan carries every value the two processes are started with", () => {
    const rendered = renderPlan({
      companion: "/companions/acme",
      companions: ["/companions/acme"],
      studioPort: 4097,
      studioHost: "0.0.0.0",
      studioWritable: true,
      studioTerminal: true,
      studioDetachMinutes: 30,
      studioAllowedHosts: ["studio.acme.test", "localhost:8080"],
      studioPublicOrigin: "https://studio.acme.test",
      gitSync: false,
      audience: "ba",
    });
    expect(rendered).toContain("MATE_PLAN_AUDIENCE='ba'");
    expect(rendered).toContain("MATE_PLAN_COMPANION='/companions/acme'");
    expect(rendered).not.toContain("AGENT_PORT");
    expect(rendered).toContain("MATE_PLAN_STUDIO_TERMINAL='1'");
    expect(rendered).toContain("MATE_PLAN_STUDIO_DETACH_MINUTES='30'");
    expect(rendered).toContain("MATE_PLAN_STUDIO_ALLOWED_HOSTS='studio.acme.test,localhost:8080'");
    expect(rendered).toContain("MATE_PLAN_STUDIO_PUBLIC_ORIGIN='https://studio.acme.test'");
    expect(rendered).toContain("MATE_PLAN_STUDIO_WRITABLE='1'");
    expect(rendered).toContain("MATE_PLAN_GIT_SYNC=''");
  });

  test("a value containing a quote is still safe to evaluate", () => {
    const rendered = renderPlan({
      companion: "/companions/it's",
      companions: [],
      studioPort: 2,
      studioHost: "h",
      studioWritable: false,
      studioTerminal: false,
      studioDetachMinutes: 30,
      studioAllowedHosts: [],
      studioPublicOrigin: null,
      gitSync: false,
      audience: null,
    });
    expect(rendered).toContain("MATE_PLAN_AUDIENCE=''");
    expect(rendered).toContain(`MATE_PLAN_COMPANION='/companions/it'\\''s'`);
  });

  test("credentials are rendered for the session's environment and are not in the plan", () => {
    const applianceConfig = config({
      credentials: { ANTHROPIC_API_KEY: "secret" },
      gitUserName: "Appliance",
      gitUserEmail: "appliance@example.com",
    });
    const credentials = renderCredentials(applianceConfig);
    expect(credentials).toContain("export ANTHROPIC_API_KEY='secret'");
    expect(credentials).toContain("export GIT_AUTHOR_NAME='Appliance'");
    expect(credentials).toContain("export GIT_COMMITTER_EMAIL='appliance@example.com'");

    makeCompanion(path.join(root, "acme"));
    const plan = renderPlan(prepareStartup(applianceConfig, deps()));
    expect(plan).not.toContain("secret");
  });

  test("startup-only tokens never travel with the credentials or the plan", () => {
    const applianceConfig = config({
      pluginRegistry: { scope: "@acme", url: "https://registry.acme.test/", token: "reg-tok" },
      gitCloneToken: "git-tok",
    });
    expect(renderCredentials(applianceConfig)).not.toMatch(/reg-tok|git-tok|MATE_ALLOWED_PLUGINS/);
    makeCompanion(path.join(root, "acme"));
    const plan = renderPlan(prepareStartup(applianceConfig, deps()));
    expect(plan).not.toMatch(/reg-tok|git-tok/);
  });

  test("without a registry, plugins are verified and nothing installs", () => {
    makeCompanion(path.join(root, "acme"));
    const { run, calls } = recorder();
    prepareStartup(config(), deps({ run }));
    expect(calls).toContainEqual(["mate", "doctor", "--json"]);
    expect(calls.some((call) => call.includes("install") || call.includes("bash"))).toBe(false);
  });

  test("with a registry, the image-owned restore runs after registration and before verification", () => {
    const companion = makeCompanion(path.join(root, "acme"));
    const { run, calls, envs } = recorder();
    prepareStartup(
      config({
        pluginRegistry: { scope: "@acme", url: "https://registry.acme.test/", token: "reg-tok" },
      }),
      deps({ run }),
    );
    const order = calls.map((call) =>
      call[1] === "companion"
        ? call[2]
        : call[0] === "bash"
          ? "setup"
          : call[1] === "doctor"
            ? "verify"
            : call[2],
    );
    expect(order.indexOf("register")).toBeLessThan(order.indexOf("setup"));
    expect(order.indexOf("setup")).toBeLessThan(order.indexOf("verify"));
    expect(order.indexOf("verify")).toBeLessThan(order.indexOf("prepare"));
    const at = calls.findIndex((call) => call[0] === "bash");
    expect(calls[at]).toEqual(["bash", "/opt/mate/tools/startup/setup.sh", companion]);
    expect(envs[at]).toMatchObject({
      MATE_PLUGIN_REGISTRY_SCOPE: "@acme",
      MATE_PLUGIN_REGISTRY_URL: "https://registry.acme.test/",
      MATE_PLUGIN_REGISTRY_TOKEN: "reg-tok",
    });
    expect(JSON.stringify(calls)).not.toContain("reg-tok");
  });

  test("a failed restore stops startup, redacts the token and verifies nothing", () => {
    makeCompanion(path.join(root, "acme"));
    const { run, calls } = recorder({
      "setup.sh": { status: 1, stdout: "", stderr: "npm error 401 for reg-tok\n" },
    });
    let message = "";
    try {
      prepareStartup(
        config({
          pluginRegistry: { scope: "@acme", url: "https://registry.acme.test/", token: "reg-tok" },
        }),
        deps({ run }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("401");
    expect(message).not.toContain("reg-tok");
    expect(calls.some((call) => call.includes("doctor") || call.includes("prepare"))).toBe(false);
  });

  describe("startup-only tokens are redacted from every printed failure", () => {
    const registry = { scope: "@acme", url: "https://registry.acme.test/", token: "reg-tok" };
    const leak = "leaked reg-tok and git-tok here\n";
    const failing = (match: string) =>
      recorder({ [match]: { status: 1, stdout: "", stderr: leak } });

    for (const [name, match] of [
      ["registration", "register"],
      ["restore", "setup.sh"],
      ["verification", "doctor"],
      ["preparation", "prepare"],
    ] as const) {
      test(`${name} omits both tokens`, () => {
        makeCompanion(path.join(root, "acme"));
        let message = "";
        try {
          prepareStartup(
            config({ pluginRegistry: registry, gitCloneToken: "git-tok" }),
            deps({ run: failing(match).run }),
          );
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain("leaked");
        expect(message).not.toMatch(/reg-tok|git-tok/);
      });
    }

    test("clone omits both tokens", () => {
      const { run } = recorder({ clone: { status: 128, stdout: "", stderr: leak } });
      let message = "";
      try {
        prepareStartup(
          config({
            pluginRegistry: registry,
            gitCloneToken: "git-tok",
            companionRepos: [{ url: "https://example.com/gone.git", directory: "gone" }],
          }),
          deps({ run }),
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("leaked");
      expect(message).not.toMatch(/reg-tok|git-tok/);
    });
  });

  test("a companion-local npm auth line for the registry host blocks the restore", () => {
    const companion = makeCompanion(path.join(root, "acme"));
    fs.mkdirSync(path.join(companion, ".mate", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(companion, ".mate", "plugins", ".npmrc"),
      "//pkg.acme.test/:_authToken=other\n",
    );
    const { run, calls } = recorder();
    expect(() =>
      prepareStartup(
        config({
          pluginRegistry: { scope: "@acme", url: "https://pkg.acme.test/", token: "t" },
        }),
        deps({ run }),
      ),
    ).toThrow(/\.npmrc overrides/);
    expect(calls.some((call) => call[0] === "bash")).toBe(false);
  });

  test("a companion-local npm override of the registry blocks the restore", () => {
    const companion = makeCompanion(path.join(root, "acme"));
    fs.mkdirSync(path.join(companion, ".mate", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(companion, ".mate", "plugins", ".npmrc"),
      "registry=https://x.test/\n",
    );
    const { run, calls } = recorder();
    expect(() =>
      prepareStartup(
        config({
          pluginRegistry: { scope: "@acme", url: "https://pkg.acme.test/", token: "t" },
        }),
        deps({ run }),
      ),
    ).toThrow(/\.npmrc overrides/);
    expect(calls.some((call) => call[0] === "bash")).toBe(false);
  });

  test("a declared plugin needs no operator allowlist", () => {
    makeCompanion(path.join(root, "acme"));
    expect(() => prepareStartup(config(), deps())).not.toThrow();
  });
  test("a plugin that is not ready stops startup with the reason", () => {
    makeCompanion(path.join(root, "acme"));
    const { run } = recorder({
      "mate doctor": {
        status: 1,
        stdout: "",
        stderr: "plugin @acme/reader: not installed; run setup",
      },
    });
    expect(() => prepareStartup(config(), deps({ run }))).toThrow(/@acme\/reader: not installed/);
  });

  test("a capability a verified plugin reports providing is accepted", () => {
    makeCompanion(
      path.join(root, "acme"),
      FRAMEWORK.replace("- name: openspec", "- name: acme-reader"),
    );
    const { run } = recorder({
      doctor: { status: 0, stdout: '{"pluginCapabilities":["acme-reader"]}\n', stderr: "" },
    });
    expect(() => prepareStartup(config(), deps({ run }))).not.toThrow();
  });

  test("a plugin cannot vouch for a different capability name", () => {
    makeCompanion(
      path.join(root, "acme"),
      FRAMEWORK.replace("- name: openspec", "- name: other-thing"),
    );
    const { run } = recorder({
      doctor: { status: 0, stdout: '{"pluginCapabilities":["acme-reader"]}\n', stderr: "" },
    });
    expect(() => prepareStartup(config(), deps({ run }))).toThrow(/capability "other-thing"/);
  });

  test("a plugin's capability does not excuse an unsupported package manager", () => {
    expect(() =>
      assertRequirementsCarried(
        { packageManagers: ["pnpm"], capabilities: ["acme-reader"] },
        () => true,
        ["acme-reader"],
      ),
    ).toThrow(/package manager "pnpm"/);
  });

  test("unreadable doctor output provides nothing", () => {
    expect(parsePluginCapabilities("")).toEqual([]);
    expect(parsePluginCapabilities("not json")).toEqual([]);
    expect(parsePluginCapabilities('{"pluginCapabilities":["a",1]}')).toEqual(["a"]);
  });

  test("an unknown capability is refused by name even when a declared plugin might supply it", () => {
    makeCompanion(
      path.join(root, "acme"),
      FRAMEWORK.replace("- name: openspec", "- name: acme-reader"),
    );
    expect(() => prepareStartup(config(), deps())).toThrow(/capability "acme-reader"/);
  });

  test("an absent checkout gets the operator's setup command, a missing package is named by verify", () => {
    fs.mkdirSync(path.join(root, "empty"));
    expect(() =>
      prepareStartup(
        config({
          companionsDir: path.join(root, "empty"),
          setupHint: "Run `docker compose run --rm setup`.",
        }),
        deps(),
      ),
    ).toThrow(/docker compose run --rm setup/);
  });

  test("a pinned Studio token travels with the credentials, never the plan", () => {
    const applianceConfig = config({ studioToken: "s".repeat(40) });
    expect(renderCredentials(applianceConfig)).toContain(
      `export MATE_STUDIO_TOKEN='${"s".repeat(40)}'`,
    );
    makeCompanion(path.join(root, "acme"));
    expect(renderPlan(prepareStartup(applianceConfig, deps()))).not.toContain("s".repeat(40));
  });

  test("a stale allowlist setting is warned about by name", () => {
    makeCompanion(path.join(root, "acme"));
    const lines: string[] = [];
    prepareStartup(
      config({ removed: ["MATE_ALLOWED_PLUGINS"] }),
      deps({ log: (line) => lines.push(line) }),
    );
    expect(lines.some((line) => line.includes("MATE_ALLOWED_PLUGINS is no longer used"))).toBe(
      true,
    );
  });

  test("a removed agent setting is warned about by name", () => {
    makeCompanion(path.join(root, "acme"));
    const lines: string[] = [];
    prepareStartup(
      config({ removed: ["MATE_AGENT_PORT"] }),
      deps({ log: (line) => lines.push(line) }),
    );
    expect(lines.some((line) => line.includes("MATE_AGENT_PORT is no longer used"))).toBe(true);
  });

  test("nothing a credential contains is written into the companion", () => {
    const companion = makeCompanion(path.join(root, "acme"));
    prepareStartup(config({ credentials: { ANTHROPIC_API_KEY: "secret" } }), deps());

    const walk = (directory: string): string[] =>
      fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(full) : [fs.readFileSync(full, "utf8")];
      });
    expect(walk(companion).some((contents) => contents.includes("secret"))).toBe(false);
  });
});

const AUDIENCE_FRAMEWORK = `${FRAMEWORK}audiences:
  ba:
    plugins: []
  qa:
    plugins: []
`;

describe("serving one audience", () => {
  test("a declared audience is served, logged and carried in the plan", () => {
    makeCompanion(path.join(root, "acme"), AUDIENCE_FRAMEWORK);
    const lines: string[] = [];

    const plan = prepareStartup(config({ audience: "ba" }), deps({ log: (l) => lines.push(l) }));

    expect(plan.audience).toBe("ba");
    expect(lines).toContain("serving audience ba");
    expect(renderPlan(plan)).toContain("MATE_PLAN_AUDIENCE='ba'");
  });

  test("an undeclared audience stops before setup, naming it and the declared ones", () => {
    makeCompanion(path.join(root, "acme"), AUDIENCE_FRAMEWORK);
    const { run, calls } = recorder();

    expect(() =>
      prepareStartup(
        config({
          audience: "dev",
          pluginRegistry: { scope: "@acme", url: "https://registry.acme.test/", token: "tok" },
        }),
        deps({ run }),
      ),
    ).toThrow(/"dev".*ba, qa/s);

    expect(calls.some((call) => call.includes("doctor") || call.join(" ").includes("setup"))).toBe(
      false,
    );
  });

  test("an audience on a companion that declares none is undeclared", () => {
    makeCompanion(path.join(root, "acme"));

    expect(() => prepareStartup(config({ audience: "ba" }), deps())).toThrow(/"ba".*none/s);
  });

  test("no audience leaves startup, the plan and the child environments as before", () => {
    makeCompanion(path.join(root, "acme"), AUDIENCE_FRAMEWORK);
    const { run, envs } = recorder();
    const lines: string[] = [];

    const plan = prepareStartup(
      config({
        pluginRegistry: { scope: "@acme", url: "https://registry.acme.test/", token: "tok" },
      }),
      deps({ run, log: (l) => lines.push(l) }),
    );

    expect(plan.audience).toBeNull();
    expect(renderPlan(plan)).toContain("MATE_PLAN_AUDIENCE=''");
    expect(lines.some((line) => line.includes("audience"))).toBe(false);
    expect(envs.every((env) => !env || !("MATE_AUDIENCE" in env))).toBe(true);
  });

  test("the audience reaches the setup script and the strict verification run", () => {
    makeCompanion(path.join(root, "acme"), AUDIENCE_FRAMEWORK);
    const { run, calls, envs } = recorder();

    prepareStartup(
      config({
        audience: "ba",
        pluginRegistry: { scope: "@acme", url: "https://registry.acme.test/", token: "tok" },
      }),
      deps({ run }),
    );

    const setup = calls.findIndex((call) => call[0] === "bash");
    const verify = calls.findIndex((call) => call.includes("doctor"));
    expect(envs[setup]?.MATE_AUDIENCE).toBe("ba");
    expect(envs[verify]).toEqual({ MATE_AUDIENCE: "ba" });
  });

  test("the audience is never written into the companion", () => {
    const companion = makeCompanion(path.join(root, "acme"), AUDIENCE_FRAMEWORK);

    prepareStartup(config({ audience: "ba" }), deps());

    expect(fs.readFileSync(path.join(companion, ".mate", "config", "framework.yaml"), "utf8")).toBe(
      AUDIENCE_FRAMEWORK,
    );
  });
});
