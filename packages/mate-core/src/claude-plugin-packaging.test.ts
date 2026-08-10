import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
  pluginRoot = path.join(extracted, "package", "claude-plugin");

  // An installed package always has its runtime dependencies next to it;
  // mirror that offline by symlinking the workspace's resolved node_modules
  // into the extracted package (the activation hook imports `yaml`).
  await fs.symlink(
    path.join(packageRoot, "node_modules"),
    path.join(extracted, "package", "node_modules"),
    "dir",
  );
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
  const result = spawnSync("node", [path.join(pluginRoot, "hooks", shim)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe("packed Claude plugin", () => {
  test("ships the manifest, hook wiring, and executable shims", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("mate");

    const wiring = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(wiring.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart"]);

    for (const shim of [
      "validate-artifact-path.mjs",
      "session-activation.mjs",
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

  test("session-activation shim is a silent no-op outside Mate repositories", async () => {
    const nonMate = await fs.mkdtemp(path.join(os.tmpdir(), "mate-shim-non-mate-"));
    tempRoots.push(nonMate);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mate-shim-home-"));
    tempRoots.push(home);

    const result = runShim("session-activation.mjs", {}, { HOME: home }, nonMate);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("session-activation shim injects the companion policy for a trusted linked repo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-shim-activate-"));
    tempRoots.push(root);
    const repo = path.join(root, "repo");
    const companion = path.join(root, "companion");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(repo, ".mate", "config"), { recursive: true });
    await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
    await fs.mkdir(path.join(home, ".mate"), { recursive: true });

    await fs.writeFile(
      path.join(repo, ".mate", "config", "registry.yaml"),
      [
        "repository:",
        "  id: acme",
        `  path: ${repo}`,
        "companions:",
        `  - path: ${companion}`,
        "    repositoryId: acme",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(companion, ".mate", "config", "framework.yaml"),
      "type: companion\nallowedAgents:\n  - claude\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(home, ".mate", "config.yaml"),
      ["version: 1", "companions:", `  - path: ${companion}`, ""].join("\n"),
      "utf8",
    );

    const result = runShim("session-activation.mjs", {}, { HOME: home }, repo);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      systemMessage: string;
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain("<companion-policy");
    expect(payload.hookSpecificOutput.additionalContext).toContain(companion);
    // Nothing was materialized, so the freshness nudge points at mate sync.
    expect(payload.hookSpecificOutput.additionalContext).toContain("mate sync");
    expect(payload.systemMessage).toContain(companion);
  });

  test("session-activation shim warns on an untrusted committed pointer without activating", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-shim-untrusted-"));
    tempRoots.push(root);
    const repo = path.join(root, "repo");
    const companion = path.join(root, "companion");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(repo, ".mate", "config"), { recursive: true });
    await fs.mkdir(companion, { recursive: true });
    await fs.mkdir(home, { recursive: true });

    await fs.writeFile(
      path.join(repo, ".mate", "config", "registry.yaml"),
      ["companions:", `  - path: ${companion}`, "    repositoryId: acme", ""].join("\n"),
      "utf8",
    );

    const result = runShim("session-activation.mjs", {}, { HOME: home }, repo);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      systemMessage: string;
      hookSpecificOutput?: unknown;
    };
    expect(payload.systemMessage).toContain("untrusted");
    expect(payload.systemMessage).toContain(companion);
    expect(payload.hookSpecificOutput).toBeUndefined();
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
