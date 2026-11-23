import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { withEnv } from "../../../test/fixtures";
import { frictionLogDir, readEvents } from "./runtime/friction-log";
import { writeFrictionSwitch } from "./runtime/friction-switch";

let mainImpl: (argv?: string[]) => Promise<void> = async () => {};

const { createMate } = await import("./create-mate");
const { getActiveDistribution, resetActiveDistribution } = await import("./distribution");
import type { Plugin } from "./tools/setup/plugin";

function makePlugin(id: string, kind: Plugin["kind"] = "capability"): Plugin {
  return {
    id,
    kind,
    label: id,
    description: "",
    defaultSelected: false,
    isEnabled: () => true,
    async apply() {},
    async teardown() {},
  };
}

const acmeConfig = {
  runtime: "bun",
  version: "1.0.0",
  update: {
    packageName: "@acme/mate",
    registry: "https://npm.acme.test/",
  },
};

afterEach(() => {
  resetActiveDistribution();
});

describe("createMate", () => {
  test("builds the registry from bun, uv (enabled only by its dependents), the provided plugin entries, and the built-in gitignore plugin", () => {
    const pluginA = makePlugin("acme-a");
    const pluginB = makePlugin("acme-b");
    const cli = createMate({
      config: acmeConfig,
      plugins: [pluginA, { plugin: pluginB, policy: "required" }],
    });

    const all = cli.registry.getAll();
    expect(all.map((plugin) => plugin.id)).toEqual(["acme-a", "acme-b", "bun", "uv", "gitignore"]);
    expect(cli.registry.getPolicy("bun")).toBe("required");
    expect(cli.registry.getPolicy("uv")).toBe("optional");
    expect(cli.registry.getPolicy("acme-b")).toBe("required");
  });

  test("adds only bun, uv, and the built-in gitignore plugin when the plugins list is empty", () => {
    const cli = createMate({ config: acmeConfig, plugins: [] });
    expect(cli.registry.getAll().map((plugin) => plugin.id)).toEqual(["bun", "uv", "gitignore"]);
  });

  test("threads the distribution config and registry to the active distribution", () => {
    const cli = createMate({ config: acmeConfig, plugins: [makePlugin("acme-a")] });

    const active = getActiveDistribution();
    expect(active.config.version).toBe("1.0.0");
    expect(active.config.update).toEqual({
      packageName: "@acme/mate",
      registry: "https://npm.acme.test/",
    });
    expect(active.registry).toBe(cli.registry);
  });

  test("returns a runnable CLI", () => {
    const cli = createMate({ config: acmeConfig, plugins: [] });
    expect(typeof cli.run).toBe("function");
  });

  test("run() catches a rejection from main, reports it, and sets a failing exit code", async () => {
    mainImpl = async () => {
      throw new Error("boom");
    };

    const cli = createMate({ config: acmeConfig, plugins: [], main: (argv) => mainImpl(argv) });
    const errors: unknown[] = [];
    const originalConsoleError = console.error;
    const originalExitCode = process.exitCode;
    console.error = (...args: unknown[]) => errors.push(...args);

    try {
      await expect(cli.run([])).resolves.toBeUndefined();
      expect(errors).toEqual(["boom"]);
      expect(process.exitCode).toBe(1);
    } finally {
      console.error = originalConsoleError;
      process.exitCode = originalExitCode;
    }
  });
});

describe("active distribution fallback", () => {
  test("falls back to the mate distribution defaults when createMate has not run", () => {
    const active = getActiveDistribution();
    const ids = active.registry.getAll().map((plugin) => plugin.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("opencode");
    expect(ids).toContain("gitignore");
  });
});

describe("createMate records a failed agent-run command as friction", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function companionSelectingFriction(): { home: string; companion: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-command-friction-"));
    roots.push(root);
    const companion = path.join(root, "companion");
    fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(companion, ".mate", "config", "framework.yaml"),
      "capabilities: []\n",
    );
    const home = path.join(root, "home");
    writeFrictionSwitch(true, home);
    return { home, companion };
  }

  async function runFailing(
    env: Record<string, string | undefined>,
    exitCode: number,
    argv = ["bun", "mate", "artifact", "archive", "--bogus", "acme"],
    print: () => void = () => console.error("Unknown flag: --bogus"),
  ): Promise<{ printed: unknown[]; stdout: unknown[] }> {
    const cli = createMate({
      config: acmeConfig,
      plugins: [],
      main: async () => {
        print();
        process.exitCode = exitCode;
      },
    });
    const printed: unknown[] = [];
    const stdout: unknown[] = [];
    const originalConsoleError = console.error;
    const originalWrite = process.stderr.write;
    const originalStdoutWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    console.error = (...args: unknown[]) => printed.push(...args);
    process.stderr.write = ((chunk: unknown) => printed.push(chunk) > 0) as typeof originalWrite;
    process.stdout.write = ((chunk: unknown) => stdout.push(chunk) > 0) as typeof originalWrite;
    try {
      await withEnv(env, () => cli.run(argv));
      expect(process.exitCode).toBe(exitCode);
    } finally {
      console.error = originalConsoleError;
      process.stderr.write = originalWrite;
      process.stdout.write = originalStdoutWrite;
      // Bun keeps a non-zero exit code when it is set back to undefined.
      process.exitCode = originalExitCode ?? 0;
    }
    return { printed, stdout };
  }

  const noSession = { CLAUDE_CODE_SESSION_ID: undefined, OPENCODE_SESSION_ID: undefined };

  test("records one event in an agent session, and adds the nudge line after its output", async () => {
    const { home, companion } = companionSelectingFriction();

    const { printed } = await runFailing(
      { ...noSession, HOME: home, MATE_ARTIFACT_PATH: companion, CLAUDE_CODE_SESSION_ID: "s1" },
      1,
    );

    const [event] = readEvents({ sinceDays: 1, homeDir: home });
    expect(printed).toEqual([
      "Unknown flag: --bogus",
      `Wrong or unclear? Run: mate friction report ${event.id} --kind <bug|unclear> --expected "<what you expected>". Then continue with your task.\n`,
    ]);
    expect(readEvents({ sinceDays: 1, homeDir: home })).toMatchObject([
      {
        kind: "command-failure",
        fingerprint: "command:artifact archive:1",
        runtime: "claude",
        sessionId: "s1",
        mateVersion: "1.0.0",
        companion,
        detail: {
          command: "artifact",
          subcommand: "archive",
          flags: ["--bogus"],
          exitCode: 1,
          errorText: "Unknown flag: --bogus",
        },
      },
    ]);
  });

  test("keeps direct stderr writes, and no echoed argument longer than the kept tail", async () => {
    const { home, companion } = companionSelectingFriction();
    const token = `acme${"x".repeat(1_500)}`;

    const { printed } = await runFailing(
      { ...noSession, HOME: home, MATE_ARTIFACT_PATH: companion, CLAUDE_CODE_SESSION_ID: "s1" },
      1,
      ["bun", "mate", "companion", "prepare", `--token=${token}`],
      () => process.stderr.write(`Unsupported argument: --token=${token}\n`),
    );

    expect(printed[0]).toBe(`Unsupported argument: --token=${token}\n`);
    const [event] = readEvents({ sinceDays: 1, homeDir: home });
    expect(event.detail.errorText).toBe("Unsupported argument: --token=…");
  });

  test("keeps no value of a secret-named variable that the error text echoes", async () => {
    const { home, companion } = companionSelectingFriction();
    const secret = "acme-secret-value-123";

    await runFailing(
      {
        ...noSession,
        HOME: home,
        MATE_ARTIFACT_PATH: companion,
        CLAUDE_CODE_SESSION_ID: "s1",
        ACME_TOKEN: secret,
      },
      1,
      ["bun", "mate", "companion", "sync"],
      () => process.stderr.write(`fatal: https://x:${secret}@example.com/acme\n`),
    );

    const [event] = readEvents({ sinceDays: 1, homeDir: home });
    expect(event.detail.errorText).toBe("fatal: https://x:***@example.com/acme");
  });

  test("a failed JSON command keeps its stdout; a repeat and a failed friction command get no nudge", async () => {
    const { home, companion } = companionSelectingFriction();
    const env = {
      ...noSession,
      HOME: home,
      MATE_ARTIFACT_PATH: companion,
      CLAUDE_CODE_SESSION_ID: "s1",
    };
    const document = '{"kind":"error","version":1}\n';
    const json = ["bun", "mate", "artifact", "archive", "--json"];
    const printJson = () => process.stdout.write(document);

    const first = await runFailing(env, 1, json, printJson);
    const repeat = await runFailing(env, 1, json, printJson);
    const report = await runFailing(env, 1, ["bun", "mate", "friction", "report", "F-0"]);
    const off = await runFailing(env, 1, ["bun", "mate", "friction", "off"]);

    expect(first.stdout).toEqual([document]);
    expect(first.printed).toHaveLength(1);
    expect(String(first.printed[0])).toContain("friction report");
    expect(repeat.printed).toEqual([]);
    expect(report.printed).toEqual(["Unknown flag: --bogus"]);
    expect(off.printed).toEqual(["Unknown flag: --bogus"]);
    expect(readEvents({ sinceDays: 1, homeDir: home })).toHaveLength(4);
  });

  test("a removed working folder leaves the command's message and exit code unchanged", async () => {
    const { home, companion } = companionSelectingFriction();
    const originalCwd = process.cwd;

    try {
      const { printed } = await runFailing(
        { ...noSession, HOME: home, MATE_ARTIFACT_PATH: companion, CLAUDE_CODE_SESSION_ID: "s1" },
        1,
        undefined,
        () => {
          process.cwd = () => {
            throw new Error("ENOENT: uv_cwd");
          };
          console.error("ENOENT: uv_cwd");
        },
      );

      expect(printed).toEqual(["ENOENT: uv_cwd"]);
    } finally {
      process.cwd = originalCwd;
    }
  });

  test("records nothing without an agent session id", async () => {
    const { home, companion } = companionSelectingFriction();

    await runFailing({ ...noSession, HOME: home, MATE_ARTIFACT_PATH: companion }, 1);

    expect(fs.readdirSync(frictionLogDir(home))).toEqual(["settings.json"]);
  });

  test("records a command that ends with process.exit()", async () => {
    const { home, companion } = companionSelectingFriction();
    const cli = createMate({
      config: acmeConfig,
      plugins: [],
      main: async () => void process.emit("exit", 1),
    });

    process.exitCode = 0;
    await withEnv(
      { ...noSession, HOME: home, MATE_ARTIFACT_PATH: companion, CLAUDE_CODE_SESSION_ID: "s1" },
      () => cli.run(["bun", "mate", "companion", "link"]),
    );

    expect(readEvents({ sinceDays: 1, homeDir: home })).toMatchObject([
      { fingerprint: "command:companion link:1" },
    ]);
  });

  test("records nothing for exit code zero", async () => {
    const { home, companion } = companionSelectingFriction();

    await runFailing(
      { ...noSession, HOME: home, MATE_ARTIFACT_PATH: companion, OPENCODE_SESSION_ID: "s1" },
      0,
    );

    expect(fs.readdirSync(frictionLogDir(home))).toEqual(["settings.json"]);
  });
});
