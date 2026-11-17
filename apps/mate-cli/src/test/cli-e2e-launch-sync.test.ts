/** @test-requires sockets */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  createScenario,
  initCompanionGit,
  initWorkingRepoGit,
  linkRepository,
  readJson,
  runGit,
  runMate,
  runMateInTty,
  setupCompanion,
  writeAdapterStub,
  removeScenarios,
} from "./cli-e2e-support";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
afterEach(removeScenarios);

describe("mate CLI e2e: launch repair and sync", () => {
  test("launch repairs missing OpenCode companion runtime assets before spawn", async () => {
    const scenario = await createScenario("mate-cli-e2e-opencode-repair-");
    const capturePath = await writeAdapterStub(scenario, "opencode");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const configPath = path.join(scenario.companion, ".opencode", "opencode.json");
    await fs.rm(configPath);
    // Legacy runtime files from the copied-plugin era are cleaned up by sync.
    const legacyGuidancePath = path.join(scenario.companion, ".opencode", ".mate-guidance.json");
    await fs.writeFile(legacyGuidancePath, '{"version":1}\n', "utf8");

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["opencode", "--mode", "chat"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const repairedConfig = await fs.readFile(configPath, "utf8");
    expect(repairedConfig).not.toContain("mate-opencode-plugin");
    await expect(
      fs.access(path.join(scenario.companion, ".opencode", "tui.json")),
    ).rejects.toThrow();
    await expect(fs.access(legacyGuidancePath)).rejects.toThrow();
    const invocation = await readJson<{
      env: { MATE_GUIDANCE_JSON: string | null; OPENCODE_CONFIG_CONTENT: string | null };
    }>(capturePath);
    /** The plugin root reaches OpenCode through the wrapped document, via the runtime link. */
    expect(invocation.env.OPENCODE_CONFIG_CONTENT ?? null).toBeNull();
    const wrapped = JSON.parse(
      await fs.readFile(path.join(scenario.working, ".opencode", "opencode.json"), "utf8"),
    ) as { plugins?: string[] };
    const pluginRoots = (wrapped.plugins ?? []).filter((entry) =>
      entry.endsWith("/opencode-plugin"),
    );
    expect(pluginRoots).toHaveLength(1);
    await fs.access(path.join(pluginRoots[0]!, "server.ts"));
    const guidance = JSON.parse(invocation.env.MATE_GUIDANCE_JSON ?? "{}");
    expect(guidance.version).toBe(1);
    expect(guidance.companionGuidance).toContain("<companion-policy ");
  }, 30000);

  test("synchronizes Git-backed companions and consumes both agent bypass commands", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-git-sync-");
    const claudeCapturePath = await writeAdapterStub(scenario, "claude");
    const opencodeCapturePath = await writeAdapterStub(scenario, "opencode");
    expect(
      (
        await setupCompanion(scenario, ["--git-mode", "auto"], {
          allowedAgents: ["claude", "opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runMate(scenario, {
          cwd: scenario.companion,
          args: ["install", "--yes"],
        })
      ).exitCode,
    ).toBe(0);
    const remote = await initCompanionGit(scenario);
    const upstream = path.join(scenario.root, "companion-upstream");
    runGit(scenario.root, ["clone", "-q", remote, upstream]);
    runGit(upstream, ["config", "user.email", "mate-e2e@example.com"]);
    runGit(upstream, ["config", "user.name", "Mate E2E"]);
    await fs.writeFile(path.join(upstream, ".mate", "origin-marker"), "from origin\n");
    runGit(upstream, ["add", ".mate/origin-marker"]);
    runGit(upstream, ["commit", "-qm", "origin marker"]);
    runGit(upstream, ["push", "-q"]);

    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const syncResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["claude", "--print", "hello"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: claudeCapturePath },
    });
    expect(syncResult.exitCode).toBe(0);
    expect(await fs.readFile(path.join(scenario.companion, ".mate", "origin-marker"), "utf8")).toBe(
      "from origin\n",
    );
    const syncedInvocation = await readJson<{ argv: string[] }>(claudeCapturePath);
    expect(syncedInvocation.argv).toContain("--print");
    expect(syncedInvocation.argv).not.toContain("--no-git");

    const repeatSyncResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["claude", "--print", "again"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: claudeCapturePath },
    });
    expect(repeatSyncResult.exitCode).toBe(0);

    runGit(scenario.companion, [
      "remote",
      "set-url",
      "origin",
      path.join(scenario.root, "offline.git"),
    ]);
    const bypassResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["opencode", "--", "--no-git", "--mode", "chat"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: opencodeCapturePath },
    });
    expect(bypassResult.exitCode).toBe(0);
    const bypassInvocation = await readJson<{ argv: string[] }>(opencodeCapturePath);
    expect(bypassInvocation.argv).toContain("--mode");
    expect(bypassInvocation.argv).toContain("chat");
    expect(bypassInvocation.argv).not.toContain("--no-git");
  }, 30000);

  test("mate claude waits for a held companion sync, then synchronizes", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-lock-wait-");
    const capturePath = await writeAdapterStub(scenario, "claude");
    expect(
      (
        await setupCompanion(scenario, ["--git-mode", "auto"], {
          allowedAgents: ["claude"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);
    expect(
      (await runMate(scenario, { cwd: scenario.companion, args: ["install", "--yes"] })).exitCode,
    ).toBe(0);
    const remote = await initCompanionGit(scenario);
    const upstream = path.join(scenario.root, "companion-upstream");
    runGit(scenario.root, ["clone", "-q", remote, upstream]);
    runGit(upstream, ["config", "user.email", "mate-e2e@example.com"]);
    runGit(upstream, ["config", "user.name", "Mate E2E"]);
    await fs.writeFile(path.join(upstream, ".mate", "origin-marker"), "from origin\n");
    runGit(upstream, ["add", ".mate/origin-marker"]);
    runGit(upstream, ["commit", "-qm", "origin marker"]);
    runGit(upstream, ["push", "-q"]);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    /** A background sync in flight: a live holder's lock, released after a while. */
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    const lockPath = path.join(
      scenario.home,
      ".mate",
      "locks",
      `${createHash("sha256").update(scenario.companion).digest("hex").slice(0, 32)}.lock`,
    );
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, String(holder.pid));
    const HELD_MS = 1_500;
    const release = setTimeout(() => {
      void fs.rm(lockPath, { force: true });
      holder.kill();
    }, HELD_MS);

    try {
      const started = Date.now();
      const result = await runMate(scenario, {
        cwd: scenario.working,
        args: ["claude", "--print", "hello"],
        input: "y\n",
        env: { MATE_E2E_CAPTURE_PATH: capturePath },
      });

      expect(result.exitCode).toBe(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(HELD_MS);
      expect(result.stderr).toContain("waiting for another companion sync to finish");
      expect(
        await fs.readFile(path.join(scenario.companion, ".mate", "origin-marker"), "utf8"),
      ).toBe("from origin\n");
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      clearTimeout(release);
      holder.kill();
    }
  }, 30000);

  test("launch fails early when the OpenCode companion runtime remains invalid", async () => {
    const scenario = await createScenario("mate-cli-e2e-opencode-preflight-");
    const capturePath = await writeAdapterStub(scenario, "opencode");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    // Corrupt opencode.json: launch-time sync leaves unparseable user config
    // untouched, so preflight must fail before spawning OpenCode.
    await fs.writeFile(
      path.join(scenario.companion, ".opencode", "opencode.json"),
      "{ not json\n",
      "utf8",
    );

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["opencode", "--mode", "chat"],
      input: "y\n",
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OpenCode companion runtime is invalid");
    expect(result.stderr).toContain("Unreadable OpenCode configuration");
    expect(result.stderr).toContain("re-running `mate companion setup`");
    await expect(fs.access(capturePath)).rejects.toThrow();
  });

  test(
    "interactive launch can explicitly skip review confirmation",
    { timeout: 30_000 },
    async () => {
      const scenario = await createScenario("mate-cli-e2e-launch-direct-");
      const capturePath = await writeAdapterStub(scenario, "claude");

      initWorkingRepoGit(scenario);
      expect(
        (
          await setupCompanion(scenario, [], {
            allowedAgents: ["claude"],
            capabilities: ["openspec"],
          })
        ).exitCode,
      ).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);

      const result = await runMateInTty(scenario, {
        cwd: scenario.working,
        args: ["claude", "--", "--yes"],
        inputChunks: [],
        env: { MATE_E2E_CAPTURE_PATH: capturePath },
        timeoutSeconds: 15,
      });

      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain("Aborted.");

      const invocation = await readJson<{ cwd: string; argv: string[] }>(capturePath);
      expect(invocation.cwd).toBe(scenario.working);
      expect(invocation.argv).toContain("--append-system-prompt");
    },
  );

  test("launches companion-scoped OpenCode unattended without repository indexing", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-companion-only-");
    const capturePath = await writeAdapterStub(scenario, "opencode");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["opencode", "--", "--companion"],
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Indexing graphify");
    expect(result.stdout).not.toContain("Indexing tokensave");

    const invocation = await readJson<{
      cwd: string;
      env: Record<string, string | null>;
    }>(capturePath);
    expect(invocation.cwd).toBe(scenario.companion);
    expect(invocation.env.MATE_ARTIFACT_PATH).toBe(scenario.companion);
    expect(invocation.env.MATE_REPO_PATH).toBeNull();
    expect(invocation.env.MATE_REPO_ID).toBeNull();
    expect(invocation.env.GRAPHIFY_OUT).toBe(
      path.join(scenario.companion, ".graphify", "__companion__", "graphify-out"),
    );
  });

  test("claude setup writes companion guidance artifacts", async () => {
    const scenario = await createScenario("mate-cli-e2e-claude-guidance-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    await fs.access(path.join(scenario.companion, "AGENTS.md"));
    await fs.access(path.join(scenario.companion, "CLAUDE.md"));
    await expect(
      fs.access(path.join(scenario.companion, ".claude", "CLAUDE.md")),
    ).rejects.toThrow();
  });
});
