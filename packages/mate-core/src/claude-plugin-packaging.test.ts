import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { MATE_CLAUDE_PLUGIN_NAME } from "./lib/package-paths";
import { ARTIFACT_REFUSAL_HEADLINE } from "./runtime/artifact-refusal";
import { MATE_ENV } from "./runtime/env-names";
import { writeProjectionPair } from "./runtime/projection";
import { repoLocalRegistryPath } from "./runtime/repo-local";

// Packs the package once and executes every bundled Claude plugin hook shim
// against fixture hook payloads, proving the shipped plugin is loadable and
// speaks the hook protocol from inside the tarball layout.
const tempRoots: string[] = [];
let pluginRoot: string;

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-claude-plugin-pack-"));
  tempRoots.push(root);
  const packageRoot = path.join(import.meta.dirname, "..");
  const pack = spawnSync("bun", ["pm", "pack", "--destination", root], {
    cwd: packageRoot,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
  });
  expect(pack.status).toBe(0);

  const tarball = (await fs.readdir(root)).find((entry) => entry.endsWith(".tgz"));
  expect(tarball).toBeDefined();

  // Extract under a node_modules segment: node refuses native type stripping
  // there (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so this exercises the
  // shims exactly as an installed package would.
  const extracted = path.join(root, "node_modules", "@acme");
  await fs.mkdir(extracted, { recursive: true });
  const unpack = spawnSync("tar", ["-xzf", path.join(root, tarball!), "-C", extracted], {
    encoding: "utf8",
  });
  expect(unpack.status).toBe(0);

  // Hoist the runtime dependencies the hook import graph reaches, so the
  // fixture is an installed package rather than a bare tarball: without them
  // the shims would fail on resolution the real install satisfies.
  for (const dependency of ["yaml"]) {
    await fs.symlink(
      await fs.realpath(path.join(packageRoot, "node_modules", dependency)),
      path.join(root, "node_modules", dependency),
      "dir",
    );
  }

  pluginRoot = path.join(extracted, "package", "claude-plugin");
});

afterAll(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

/** An empty override unsets the variable, since `hasLaunchEnvironment` counts "" as present. */
function shimEnvironment(env: Record<string, string>): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [name, value] of Object.entries(env)) if (value === "") delete merged[name];
  return merged;
}

function runShimRaw(
  shim: string,
  input: string,
  env: Record<string, string> = {},
  cwd?: string,
  argv: readonly string[] = [],
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [path.join(pluginRoot, "hooks", shim), ...argv], {
    input,
    encoding: "utf8",
    env: shimEnvironment(env),
    cwd,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function runShim(
  shim: string,
  payload: unknown,
  env: Record<string, string> = {},
  cwd?: string,
  argv: readonly string[] = [],
): { exitCode: number; stdout: string; stderr: string } {
  return runShimRaw(shim, JSON.stringify(payload), env, cwd, argv);
}

/** The harness may itself run under a Mate launch; an unmanaged shim must not inherit it. */
function withoutLaunchEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.values(MATE_ENV).map((name) => [name, ""]));
}

async function wrapRepo(repoRoot: string, companionPath: string): Promise<void> {
  const registryPath = repoLocalRegistryPath(repoRoot);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "companions: []\n", "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "written-by-another-mate",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: path.join(companionPath, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });
}

describe("packed Claude plugin", () => {
  test("ships the manifest, hook wiring, and executable shims", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    /** The sync pass leaves out any contributed folder using this name. */
    expect(manifest.name).toBe(MATE_CLAUDE_PLUGIN_NAME);

    const wiring = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(Object.keys(wiring.hooks).sort()).toEqual([
      "PreToolUse",
      "SessionStart",
      "SubagentStart",
    ]);
    const commands = (event: string) =>
      wiring.hooks[event]!.flatMap((group) => group.hooks.map((h) => h.command));
    /** The main thread's copy comes from the prepare hook, after it prepares: an event's hooks run in parallel. */
    expect(
      commands("SessionStart").filter((c) => c.includes("companion-instructions.mjs")),
    ).toEqual([]);
    expect(commands("SubagentStart")).toEqual([
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/companion-instructions.mjs"',
    ]);

    for (const shim of [
      "validate-artifact-path.mjs",
      "session-banner.mjs",
      "session-guidance.mjs",
      "session-prepare.mjs",
      "companion-instructions.mjs",
    ]) {
      const stat = await fs.stat(path.join(pluginRoot, "hooks", shim));
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }

    await expect(
      fs.stat(path.join(pluginRoot, "hooks", "artifact-finish-nudge.mjs")),
    ).rejects.toThrow();
  });

  test("validate-artifact-path shim blocks artifact writes to the working repo", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "mate-shim-repo-"));
    tempRoots.push(repo);
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });

    const blocked = runShim(
      "validate-artifact-path.mjs",
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "design.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain(ARTIFACT_REFUSAL_HEADLINE);

    const allowed = runShim(
      "validate-artifact-path.mjs",
      { tool_name: "Write", tool_input: { file_path: path.join(companion, "design.md") } },
      { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
    );
    expect(allowed.exitCode).toBe(0);
  });

  test("validate-artifact-path shim resolves a projection from inside the install", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "mate-shim-wrapped-"));
    tempRoots.push(repo);
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    await wrapRepo(repo, companion);

    const blocked = runShim(
      "validate-artifact-path.mjs",
      { tool_name: "Write", tool_input: { file_path: path.join(repo, "design.md") } },
      withoutLaunchEnvironment(),
      repo,
    );
    expect(blocked.stderr).toContain(ARTIFACT_REFUSAL_HEADLINE);
    expect(blocked.exitCode).toBe(2);
  });

  test("the wrap-carried session-prepare shim delivers the companion AGENTS.md from inside the install", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "mate-shim-instructions-"));
    tempRoots.push(repo);
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.writeFile(path.join(companion, "AGENTS.md"), "## Git\n\nACME-SHIM-SENTINEL\n");
    await wrapRepo(repo, companion);
    const input = { hook_event_name: "SessionStart", source: "startup" };

    const carried = runShim("session-prepare.mjs", input, withoutLaunchEnvironment(), repo, [
      "--projected",
    ]);

    expect(carried.exitCode).toBe(0);
    expect(carried.stderr).toBe("");
    const payload = JSON.parse(carried.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(payload.hookSpecificOutput.additionalContext).toContain("ACME-SHIM-SENTINEL");

    /** The plugin's bare copy never owns the main thread, so a session loading both gets one copy. */
    const bare = runShim(
      "session-prepare.mjs",
      input,
      { ...withoutLaunchEnvironment(), CLAUDE_PLUGIN_ROOT: pluginRoot },
      repo,
    );
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).not.toContain("ACME-SHIM-SENTINEL");
  });

  test("the companion-instructions shim reads input that is not JSON as no event", () => {
    const result = runShimRaw(
      "companion-instructions.mjs",
      "not json",
      withoutLaunchEnvironment(),
      undefined,
      ["--projected"],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("the companion-instructions shim exits zero when its output pipe is closed", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "mate-shim-closed-pipe-"));
    tempRoots.push(repo);
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await fs.writeFile(path.join(companion, "AGENTS.md"), "## Git\n\nACME-SHIM-SENTINEL\n");
    await wrapRepo(repo, companion);

    const child = spawn(
      "node",
      [path.join(pluginRoot, "hooks", "companion-instructions.mjs"), "--projected"],
      { cwd: repo, env: shimEnvironment(withoutLaunchEnvironment()), stdio: "pipe" },
    );
    child.stdout.destroy();
    child.stdin.end(JSON.stringify({ hook_event_name: "SubagentStart", agent_type: "acme" }));

    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(exitCode).toBe(0);
  });

  test("session-prepare shim is inert under a launch environment", () => {
    const result = runShim("session-prepare.mjs", {}, { MATE_ARTIFACT_PATH: "/companions/acme" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("session-banner shim emits the managed-session banner", () => {
    const result = runShim(
      "session-banner.mjs",
      {},
      {
        MATE_REPO_PATH: "/work/acme",
        MATE_ARTIFACT_PATH: "/companions/acme-companion",
        MATE_VERSION: "9.9.9",
      },
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { systemMessage: string };
    expect(payload.systemMessage).toContain("mate v9.9.9");
    expect(payload.systemMessage).toContain("/companions/acme-companion");
  });
});
