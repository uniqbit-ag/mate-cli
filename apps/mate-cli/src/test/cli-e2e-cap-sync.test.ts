/** @test-requires sockets */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  createScenario,
  initWorkingRepoGit,
  installCompanion,
  linkRepository,
  readJson,
  runMate,
  setupCompanion,
  writeAdapterStub,
  writeTokensaveSyncStub,
  removeScenarios,
} from "./cli-e2e-support";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
afterEach(removeScenarios);

describe("mate CLI e2e: capability sync and guidance", () => {
  test("cap rejects direct tokensave passthrough in favor of the native tokensave cli", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-tokensave-disabled-");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["tokensave"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "tokensave", "status"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mate: unknown capability command: tokensave");
  });

  test("cap sync runs tokensave by default", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-sync-");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["tokensave"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    // setupCompanion rewrites the capability stubs, so install the sync-aware stub
    // afterwards to overwrite it.
    const tokensaveCapture = await writeTokensaveSyncStub(scenario);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "sync"],
      env: { MATE_E2E_TOKENSAVE_CAPTURE_PATH: tokensaveCapture },
    });

    expect(result.exitCode).toBe(0);
    const invocation = await readJson<{ argv: string[] }>(tokensaveCapture);
    expect(invocation.argv).toEqual(["sync"]);
  });

  test("launch installs tokensave MCP wiring for claude in companion settings", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-tokensave-claude-");
    const capturePath = await writeAdapterStub(scenario, "claude");
    initWorkingRepoGit(scenario);

    const setup = await setupCompanion(scenario, [], {
      allowedAgents: ["claude"],
      capabilities: ["tokensave"],
    });
    expect(setup.exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["claude", "--print", "hello"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const settings = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".claude", "settings.local.json"), "utf8"),
    );
    /** MCP server in companion .mcp.json, not settings.local.json; its permission is still pre-seeded. */
    expect(settings.mcpServers?.tokensave).toBeUndefined();
    expect(settings.permissions?.allow ?? []).toContain("mcp__tokensave__*");
    const mcpConfig = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".mcp.json"), "utf8"),
    );
    // The MCP registration keeps the bare command name — it's resolved
    // against PATH at spawn time by the hosting agent, not pinned here.
    expect(mcpConfig.mcpServers?.tokensave).toEqual({
      command: "tokensave",
      args: ["serve"],
    });
    /** The launch wraps: the MCP server reaches the repository's `~/.claude.json` entry once. */
    const globalConfig = JSON.parse(
      await fs.readFile(path.join(scenario.home, ".claude.json"), "utf8"),
    ) as { projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
    const projectEntries = Object.entries(globalConfig.projects ?? {}).filter(
      ([, entry]) => entry.mcpServers?.tokensave,
    );
    expect(projectEntries).toHaveLength(1);
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).not.toContain("--mcp-config");
    await expect(fs.access(path.join(scenario.working, ".mcp.json"))).rejects.toThrow();
  });

  test("launch delivers exploration guidance to OpenCode through the launch environment", async () => {
    const scenario = await createScenario("mate-cli-e2e-opencode-exploration-guidance-");
    const capturePath = await writeAdapterStub(scenario, "opencode");

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["opencode"],
      capabilities: ["tokensave"],
    });
    expect(result.exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const launch = await runMate(scenario, {
      cwd: scenario.working,
      args: ["opencode", "--mode", "chat"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });
    expect(launch.exitCode).toBe(0);

    const invocation = await readJson<{ env: { MATE_GUIDANCE_JSON: string | null } }>(capturePath);
    const guidance = JSON.parse(invocation.env.MATE_GUIDANCE_JSON ?? "{}");
    expect(guidance.codebaseExplorationGuidance).toContain(
      '<codebase-exploration-rules priority="mandatory">',
    );
    expect(guidance.codebaseExplorationGuidance).toContain("cap index --tokensave");
    expect(guidance.errors).toEqual([]);
  }, 30000);

  test("cap rejects unknown capability names", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-unknown-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await installCompanion(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["cap", "unknown"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown capability command");
  });

  test("top-level setup is rejected", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-top-level-rejected-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await installCompanion(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["setup"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: setup");
  });
});
