import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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

function runShim(
  shim: string,
  payload: unknown,
  env: Record<string, string> = {},
  cwd?: string,
): { exitCode: number; stdout: string; stderr: string } {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  /** An empty override unsets the variable: `hasLaunchEnvironment` counts "" as present. */
  for (const [name, value] of Object.entries(env)) if (value === "") delete merged[name];

  const result = spawnSync("node", [path.join(pluginRoot, "hooks", shim)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: merged,
    cwd,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
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
    expect(manifest.name).toBe("mate-claude-plugin");

    const wiring = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(wiring.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart"]);

    for (const shim of [
      "validate-artifact-path.mjs",
      "session-banner.mjs",
      "session-guidance.mjs",
      "artifact-finish-nudge.mjs",
    ]) {
      const stat = await fs.stat(path.join(pluginRoot, "hooks", shim));
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }
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
    expect(blocked.stderr).toContain("artifact writes must go to the companion framework path");

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
    expect(blocked.stderr).toContain("artifact writes must go to the companion framework path");
    expect(blocked.exitCode).toBe(2);
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

  test("artifact-finish-nudge shim nudges only when the gate is on", () => {
    const payload = {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "openspec archive acme --yes" },
      tool_response: { stdout: "ok", stderr: "", interrupted: false },
    };

    const gated = runShim("artifact-finish-nudge.mjs", payload, {
      MATE_OPENSPEC_ENABLED: "1",
      MATE_GIT_AUTO_MODE: "1",
    });
    expect(gated.exitCode).toBe(0);
    const output = JSON.parse(gated.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'mate artifact finish "acme" --json',
    );

    const gateOff = runShim("artifact-finish-nudge.mjs", payload, {
      MATE_OPENSPEC_ENABLED: "0",
      MATE_GIT_AUTO_MODE: "1",
    });
    expect(gateOff.exitCode).toBe(0);
    expect(gateOff.stdout).toBe("");
  });
});
