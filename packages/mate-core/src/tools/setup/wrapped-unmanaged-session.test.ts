import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runWrapCommand } from "../../cli/commands/wrap";
import { FRAMEWORK_NAME } from "../../framework";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { writeRepoLocalRegistryEntry } from "../../lib/orchestrator/repo-local-registry";
import { MATE_ENV } from "../../runtime/env-names";
import type { ClaudeHookGroup, ClaudeSettings } from "./providers/claude-format";

/**
 * Milestone M3: what a wrapped Working Repository gives an Agent Runtime that
 * Mate did not start. The assertions run the hook commands the documents
 * register, rather than trusting that a registered command would have worked.
 */

const tempRoots: string[] = [];
let originalExitCode: number | undefined;

beforeEach(() => {
  originalExitCode = process.exitCode;
});

afterEach(async () => {
  process.exitCode = originalExitCode ?? 0;
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  repoPath: string;
  companionPath: string;
}

async function makeCompanionAndRepo(prefix: string, capabilities: string[]): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repoPath, stdio: "ignore" });
  await fs.writeFile(
    path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
    [
      "allowedAgents:",
      "  - claude",
      "capabilities:",
      ...capabilities.map((name) => `  - name: ${name}`),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeRepoLocalRegistryEntry(repoPath, companionPath, { id: "acme", path: repoPath }, "git");
  await new GlobalConfigStore(path.join(root, "config.yaml")).register(companionPath);
  return { repoPath, companionPath };
}

async function readSettings(repoPath: string): Promise<ClaudeSettings | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(repoPath, ".claude", "settings.local.json"), "utf8"),
    ) as ClaudeSettings;
  } catch {
    return null;
  }
}

/** The exact command strings the discovered document registers for an event. */
function hookCommands(settings: ClaudeSettings | null, event: string): string[] {
  return (settings?.hooks?.[event] ?? []).flatMap((group: ClaudeHookGroup) =>
    (group.hooks ?? []).map((hook) => hook.command ?? ""),
  );
}

/** An Unmanaged Session: no Mate parent, no Mate variables, no Mate flags. */
function unmanagedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.values(MATE_ENV)) delete env[name];
  return env;
}

function runHookCommand(
  command: string,
  payload: unknown,
  cwd: string,
): { exitCode: number; stderr: string } {
  const result = spawnSync("sh", ["-c", command], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: unmanagedEnv(),
    cwd,
  });
  return { exitCode: result.status ?? 1, stderr: result.stderr };
}

describe("a wrapped Working Repository with an empty Mate environment", () => {
  test("registers a guard that blocks an artifact write into the Working Repository", async () => {
    const { repoPath, companionPath } = await makeCompanionAndRepo("mate-m3-guard-", []);
    await runWrapCommand(["--companion", companionPath], repoPath);

    const commands = hookCommands(await readSettings(repoPath), "PreToolUse");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("validate-artifact-path");

    const blocked = runHookCommand(
      commands[0]!,
      { tool_name: "Write", tool_input: { file_path: path.join(repoPath, "design.md") } },
      repoPath,
    );
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain("artifact writes must go to the companion framework path");

    const allowed = runHookCommand(
      commands[0]!,
      { tool_name: "Write", tool_input: { file_path: path.join(companionPath, "design.md") } },
      repoPath,
    );
    expect(allowed.exitCode).toBe(0);
  }, 20000);

  test("configures the companion's declared MCP servers", async () => {
    const { repoPath, companionPath } = await makeCompanionAndRepo("mate-m3-mcp-", ["tokensave"]);
    await runWrapCommand(["--companion", companionPath], repoPath);

    const mcp = JSON.parse(await fs.readFile(path.join(repoPath, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(["tokensave"]);
    expect(mcp.mcpServers.tokensave?.args).toEqual(["serve"]);
  }, 20000);

  test("puts the Companion Repository among the permitted directories", async () => {
    const { repoPath, companionPath } = await makeCompanionAndRepo("mate-m3-dirs-", []);
    await runWrapCommand(["--companion", companionPath], repoPath);

    const settings = await readSettings(repoPath);
    expect(settings?.permissions?.additionalDirectories).toContain(companionPath);
    expect(settings?.permissions?.allow).toContain(`Read(${companionPath}/**)`);
  }, 20000);

  test("leaves an unwrapped Working Repository inert", async () => {
    const { repoPath } = await makeCompanionAndRepo("mate-m3-inert-", []);

    expect(await readSettings(repoPath)).toBeNull();
    await expect(fs.access(path.join(repoPath, ".mcp.json"))).rejects.toThrow();

    /** The guard command an unwrapped repository never registers, run anyway. */
    const guard = path.join(
      path.resolve(import.meta.dir, "../../.."),
      "claude-plugin",
      "hooks",
      "validate-artifact-path.mjs",
    );
    const inert = runHookCommand(
      `node "${guard}"`,
      { tool_name: "Write", tool_input: { file_path: path.join(repoPath, "design.md") } },
      repoPath,
    );
    expect(inert.exitCode).toBe(0);
    expect(inert.stderr).toBe("");
  }, 20000);
});
