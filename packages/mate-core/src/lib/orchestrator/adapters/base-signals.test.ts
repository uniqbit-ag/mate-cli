import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { signalExitCode } from "./base";

const tempRoots: string[] = [];

/**
 * The launch runs out of process: a sibling test file mocks
 * `node:child_process` for the whole run, and a signal test has to spawn a real
 * agent and really signal it.
 */
const ADAPTER_MODULE = path.join(import.meta.dirname, "base.ts");
const DISTRIBUTION_MODULE = path.join(import.meta.dirname, "../../../distribution.ts");
const REGISTRY_MODULE = path.join(import.meta.dirname, "../../../tools/setup/registry.ts");

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "launch-signals-"));
  tempRoots.push(dir);
  return dir;
}

/** A launch process: spawns a real agent that outlives the test unless signalled. */
async function writeLauncher(dir: string, options: { interactive: boolean }): Promise<string> {
  const script = path.join(dir, "launch.ts");
  await fs.writeFile(
    script,
    `import { LaunchAdapter } from ${JSON.stringify(ADAPTER_MODULE)};
import { setActiveDistribution } from ${JSON.stringify(DISTRIBUTION_MODULE)};
import { PluginRegistry } from ${JSON.stringify(REGISTRY_MODULE)};

setActiveDistribution({
  config: { runtime: "bun", version: "test" },
  registry: new PluginRegistry([]),
});

class ShellAdapter extends LaunchAdapter {
  readonly toolName = "sh";
  override readonly interactive = ${options.interactive};
  buildArgs() {
    return ["-c", "echo $$ > " + ${JSON.stringify(path.join(dir, "agent.pid"))} + "; exec sleep 30"];
  }
}

/** Stands in for a terminal, which the test harness has no way to attach. */
${options.interactive ? "process.stdin.isTTY = true;" : "process.stdin.isTTY = false;"}

const result = await new ShellAdapter().run(
  {
    launchWorkingDirectory: ${JSON.stringify(dir)},
    allowedAgents: ["claude"],
    companionPath: ${JSON.stringify(dir)},
    capabilities: [],
  },
  [],
);
await Bun.write(${JSON.stringify(path.join(dir, "result.json"))}, JSON.stringify(result));
`,
    "utf8",
  );
  return script;
}

async function readPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await Bun.sleep(10);
  }
  throw new Error("the agent process never reported its pid");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readResult(dir: string): Promise<{ exitCode: number; signal: string | null }> {
  return JSON.parse(await fs.readFile(path.join(dir, "result.json"), "utf8")) as {
    exitCode: number;
    signal: string | null;
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("a launch forwards termination to the agent and waits for it", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} reaches the agent, and the launch outlives it`, async () => {
      const dir = await makeTempDir();
      const launcher = Bun.spawn(["bun", await writeLauncher(dir, { interactive: false })], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const agentPid = await readPid(path.join(dir, "agent.pid"));

      launcher.kill(signal);
      await launcher.exited;

      expect(isRunning(agentPid)).toBe(false);
      const result = await readResult(dir);
      expect(result.signal).toBe(signal);
      expect(result.exitCode).toBe(signalExitCode(signal));
    }, 20000);
  }

  test("an interactive launch at a terminal stops the agent once and then returns", async () => {
    const dir = await makeTempDir();
    const launcher = Bun.spawn(["bun", await writeLauncher(dir, { interactive: true })], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const agentPid = await readPid(path.join(dir, "agent.pid"));

    /** The terminal signals the whole foreground group, so the launch must not forward as well. */
    launcher.kill("SIGINT");
    await Bun.sleep(150);
    expect(isRunning(agentPid)).toBe(true);

    /** What the terminal would have delivered directly, delivered once. */
    process.kill(agentPid, "SIGINT");
    await launcher.exited;

    expect(isRunning(agentPid)).toBe(false);
    const result = await readResult(dir);
    expect(result.signal).toBe("SIGINT");
  }, 20000);
});
