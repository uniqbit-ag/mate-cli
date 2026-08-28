import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runWrapCommand } from "../../cli/commands/wrap";
import { FRAMEWORK_NAME } from "../../framework";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { runtimeDocumentDeps } from "../../lib/orchestrator/projection-runtime-documents";
import { writeRepoLocalRegistryEntry } from "../../lib/orchestrator/repo-local-registry";
import { MATE_ENV } from "../../runtime/env-names";
import { cleanupWorkingRepository } from "./working-repo-cleanup";
import type { ClaudeHookGroup, ClaudeSettings } from "./providers/claude-format";

/**
 * Milestone M3: what a wrapped Working Repository gives an Agent Runtime that
 * Mate did not start. The assertions run the hook commands the documents
 * register, rather than trusting that a registered command would have worked.
 */

const tempRoots: string[] = [];
let originalExitCode: number | undefined;
let fixtureHome: string;
const originalHomeDir = runtimeDocumentDeps.homeDir;

beforeEach(() => {
  originalExitCode = process.exitCode;
  /** Local-scope MCP lands in the user's home; a test must never use the real one. */
  fixtureHome = fsSync.mkdtempSync(path.join(os.tmpdir(), "mate-m3-home-"));
  tempRoots.push(fixtureHome);
  runtimeDocumentDeps.homeDir = () => fixtureHome;
});

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
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
  /** What Claude Code would layer on from the document's own `env` block. */
  settingsEnv: Record<string, string> = {},
): { exitCode: number; stderr: string; stdout: string } {
  const result = spawnSync("sh", ["-c", command], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...unmanagedEnv(), ...settingsEnv },
    cwd,
  });
  return { exitCode: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
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

  /**
   * Local scope, not `.mcp.json`: a project-scoped server stays "pending
   * approval" until a human accepts it in a session, so it would be configured
   * but not live — the one thing an Unmanaged Session cannot work around.
   */
  test("configures the companion's declared MCP servers at local scope", async () => {
    const { repoPath, companionPath } = await makeCompanionAndRepo("mate-m3-mcp-", ["tokensave"]);
    await runWrapCommand(["--companion", companionPath], repoPath);

    const config = JSON.parse(
      await fs.readFile(path.join(fixtureHome, ".claude.json"), "utf8"),
    ) as {
      projects: Record<string, { mcpServers?: Record<string, { args?: string[] }> }>;
    };
    const servers = config.projects[path.resolve(repoPath)]?.mcpServers ?? {};
    expect(Object.keys(servers)).toEqual(["tokensave"]);
    expect(servers.tokensave?.args).toEqual(["serve"]);

    /** And nothing project-scoped is left to sit pending beside it. */
    expect(
      await fs.readFile(path.join(repoPath, ".mcp.json"), "utf8").catch(() => null),
    ).toBeNull();
  }, 20000);

  /** Everything else in the user's config survives, and cleanup takes back only ours. */
  test("leaves the rest of the user's Claude config untouched, and reverts on cleanup", async () => {
    const { repoPath, companionPath } = await makeCompanionAndRepo("mate-m3-mcp-keep-", [
      "tokensave",
    ]);
    const configPath = path.join(fixtureHome, ".claude.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        numStartups: 7,
        projects: {
          "/somewhere/else": { mcpServers: { theirs: { command: "theirs" } } },
          [path.resolve(repoPath)]: { hasTrustDialogAccepted: true },
        },
      }),
      "utf8",
    );
    const before = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;

    await runWrapCommand(["--companion", companionPath], repoPath);
    const after = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      numStartups: number;
      projects: Record<string, { mcpServers?: Record<string, unknown>; [key: string]: unknown }>;
    };
    expect(after.numStartups).toBe(7);
    expect(after.projects["/somewhere/else"]?.mcpServers).toEqual({
      theirs: { command: "theirs" },
    });
    expect(after.projects[path.resolve(repoPath)]?.hasTrustDialogAccepted).toBe(true);
    expect(Object.keys(after.projects[path.resolve(repoPath)]?.mcpServers ?? {})).toEqual([
      "tokensave",
    ]);

    await cleanupWorkingRepository(repoPath);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(before);
  }, 20000);

  test("puts the Companion Repository among the permitted directories", async () => {
    const { repoPath, companionPath } = await makeCompanionAndRepo("mate-m3-dirs-", []);
    await runWrapCommand(["--companion", companionPath], repoPath);

    const settings = await readSettings(repoPath);
    expect(settings?.permissions?.additionalDirectories).toContain(companionPath);
    expect(settings?.permissions?.allow).toContain(`Read(${companionPath}/**)`);
  }, 20000);

  /**
   * An older Mate wrote the whole launch environment into this document. Claude
   * Code applies `env` to the session, so those variables reached every hook and
   * made a bare session read as managed — which silences the guidance hook by
   * design. A re-wrap has to take them back, or the repository stays broken in a
   * way nothing reports.
   */
  test("heals a legacy env block an older Mate left behind", async () => {
    const { repoPath, companionPath } = await makeCompanionAndRepo("mate-m3-legacy-env-", []);
    await fs.mkdir(path.join(repoPath, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".claude", "settings.local.json"),
      `${JSON.stringify(
        {
          env: {
            MATE_ARTIFACT_PATH: companionPath,
            MATE_REPO_PATH: repoPath,
            /** A launch variable outside `MATE_ENV`; the prefix has to catch it too. */
            MATE_OPENSPEC_ENABLED: "1",
            ACME_TOKEN: "keep-me",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await runWrapCommand(["--companion", companionPath], repoPath);

    const env = ((await readSettings(repoPath)) as { env?: Record<string, string> }).env ?? {};
    expect(Object.keys(env).filter((name) => name.startsWith("MATE_"))).toEqual([]);
    expect(env.ACME_TOKEN).toBe("keep-me");
    expect(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");

    /** The payoff: with the block healed, guidance actually crosses over. */
    const guidance = hookCommands(await readSettings(repoPath), "SessionStart").find((command) =>
      command.includes("session-guidance"),
    )!;
    const emitted = runHookCommand(guidance, {}, repoPath, env);
    expect(emitted.exitCode).toBe(0);
    expect(JSON.parse(emitted.stdout).hookSpecificOutput.additionalContext).toContain(
      "<companion-policy ",
    );
  }, 20000);

  /**
   * The banner is the only sign a bare session gives that a wrap is in effect,
   * and the one surface where a drifted projection surfaces at all. It is
   * carried with `--projected` so it stays silent under a launch, where the
   * plugin's own copy prints it; both halves of that are asserted here.
   */
  test("prints the startup banner in a session Mate did not launch", async () => {
    const { repoPath, companionPath } = await makeCompanionAndRepo("mate-m3-banner-", []);
    await runWrapCommand(["--companion", companionPath], repoPath);

    const banner = hookCommands(await readSettings(repoPath), "SessionStart").find((command) =>
      command.includes("session-banner"),
    )!;
    expect(banner).toContain("--projected");

    const printed = runHookCommand(banner, {}, repoPath);
    expect(printed.exitCode).toBe(0);
    const message = (JSON.parse(printed.stdout) as { systemMessage: string }).systemMessage;
    expect(message).toContain(repoPath);
    expect(message).toContain(companionPath);

    /** Under a launch the plugin already printed it, so this copy says nothing. */
    const managed = runHookCommand(banner, {}, repoPath, {
      [MATE_ENV.repositoryPath]: repoPath,
      [MATE_ENV.companionPath]: companionPath,
    });
    expect(managed.exitCode).toBe(0);
    expect(managed.stdout).toBe("");
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
