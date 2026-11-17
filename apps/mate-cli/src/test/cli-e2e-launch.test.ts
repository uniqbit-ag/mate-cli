/** @test-requires sockets */

import fs from "node:fs/promises";
import path from "node:path";

import { defaultSecretPolicy, secretRules } from "@uniqbit/mate-core/runtime";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  type E2EScenario,
  createScenario,
  initWorkingRepoGit,
  linkRepository,
  readJson,
  runMate,
  runMateInTty,
  setupCompanion,
  writeAdapterStub,
  removeScenarios,
} from "./cli-e2e-support";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
afterEach(removeScenarios);

describe("mate CLI e2e: launch", () => {
  test("opencode rejects disallowed tools before any adapter binary is spawned", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-disallowed-");
    const capturePath = await writeAdapterStub(scenario, "claude");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["claude", "--"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("disallowed by active repository policy.");
    await expect(fs.access(capturePath)).rejects.toThrow();
  });

  for (const testCase of [
    {
      tool: "claude" as const,
      allowedAgents: undefined,
      setupSelections: undefined,
      launchArgs: ["claude", "--print", "hello", "--", "--yes"],
      assertInvocation(
        invocation: {
          cwd: string;
          argv: string[];
          env: Record<string, string | null>;
        },
        scenario: E2EScenario,
      ) {
        /** A launch is a wrap; the launch defers companion access to it. */
        expect(invocation.argv).not.toContain("--add-dir");
        expect(invocation.argv).not.toContain("--mcp-config");
        expect(invocation.argv[0]).toBe("--append-system-prompt");
        expect(invocation.argv).toContain("--print");
        expect(invocation.argv).toContain("hello");
        expect(invocation.argv).not.toContain("--yes");
      },
    },
    {
      tool: "opencode" as const,
      allowedAgents: ["opencode"],
      setupSelections: { allowedAgents: ["opencode"], capabilities: ["openspec"] },
      launchArgs: ["opencode", "--mode", "chat", "--", "--yes"],
      assertInvocation(
        invocation: {
          cwd: string;
          argv: string[];
          env: Record<string, string | null>;
        },
        scenario: E2EScenario,
      ) {
        expect(invocation.argv[0]).toBe(scenario.working);
        expect(invocation.argv).toContain("--mode");
        expect(invocation.argv).toContain("chat");
        expect(invocation.argv).not.toContain("--yes");
        /** OpenCode 2.x treats a config dir as a replacement for the global one. */
        expect(invocation.env.OPENCODE_CONFIG_DIR ?? null).toBeNull();
      },
    },
  ]) {
    test(`launch smoke test captures adapter context for ${testCase.tool}`, async () => {
      const scenario = await createScenario(`mate-cli-e2e-launch-${testCase.tool}-`);
      const capturePath = await writeAdapterStub(scenario, testCase.tool);
      initWorkingRepoGit(scenario);

      expect((await setupCompanion(scenario, [], testCase.setupSelections)).exitCode).toBe(0);
      expect((await linkRepository(scenario)).exitCode).toBe(0);

      const result = await runMate(scenario, {
        cwd: scenario.working,
        args: testCase.launchArgs,
        env: { MATE_E2E_CAPTURE_PATH: capturePath },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Continue? [y/N]");

      const launchResult = JSON.parse(result.stdout) as { exitCode: number };
      expect(launchResult.exitCode).toBe(0);

      const invocation = await readJson<{
        cwd: string;
        argv: string[];
        env: Record<string, string | null>;
      }>(capturePath);

      expect(invocation.cwd).toBe(scenario.working);
      expect(invocation.env.MATE_ARTIFACT_PATH).toBe(scenario.companion);
      expect(invocation.env.MATE_REPO_ID).toBe("app");
      expect(invocation.env.MATE_REPO_PATH).toBe(scenario.working);
      expect(invocation.env.MATE_REPO_PROFILE).toBeUndefined();
      expect(JSON.parse(invocation.env.MATE_POLICY_JSON ?? "{}")).toEqual({
        allowedAgents: testCase.allowedAgents ?? ["claude", "opencode"],
        secrets: secretRules(defaultSecretPolicy()),
      });

      testCase.assertInvocation(invocation, scenario);
      const exclude = await fs.readFile(
        path.join(scenario.working, ".git", "info", "exclude"),
        "utf8",
      );
      expect(exclude).toContain("/.claude/");
    });
  }

  test("launch pre-seeds companion Claude hooks and permissions, git-excluded and un-duplicated", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-claude-settings-");
    const capturePath = await writeAdapterStub(scenario, "claude");
    initWorkingRepoGit(scenario);

    const setupSelections = {
      allowedAgents: ["claude"],
      capabilities: ["openspec", "react-doctor"],
    };
    expect((await setupCompanion(scenario, [], setupSelections)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const launch = async () =>
      runMate(scenario, {
        cwd: scenario.working,
        args: ["claude", "--print", "hello"],
        input: "y\n",
        env: { MATE_E2E_CAPTURE_PATH: capturePath },
      });

    interface HookGroup {
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }
    interface ClaudeSettings {
      hooks?: Record<string, HookGroup[]>;
      permissions?: { allow?: string[] };
    }
    /** Companion settings stay the source; the launch passes a derived copy via `--settings`. */
    const settingsPath = path.join(scenario.companion, ".claude", "settings.local.json");

    expect((await launch()).exitCode).toBe(0);
    const first = JSON.parse(await fs.readFile(settingsPath, "utf8")) as ClaudeSettings;

    const hasCommand = (groups: HookGroup[] | undefined, needle: string): boolean =>
      (groups ?? []).some((group) =>
        (group.hooks ?? []).some((hook) => (hook.command ?? "").includes(needle)),
      );
    // Mate's own hooks ship in the bundled Claude plugin (loaded via
    // --plugin-dir), so settings carry only capability hooks.
    expect(hasCommand(first.hooks?.PreToolUse, "validate-artifact-path")).toBe(false);
    expect(hasCommand(first.hooks?.SessionStart, "mate-session-banner")).toBe(false);
    // React Doctor runs only through the mate-react-doctor skill, so it
    // contributes no hooks, only the skill and pinned-binary pre-seeds.
    expect(hasCommand(first.hooks?.Stop, "react-doctor.sh")).toBe(false);
    expect(hasCommand(first.hooks?.PostToolUse, "react-doctor.sh")).toBe(false);
    expect(first.permissions?.allow).toContain("Bash(openspec:*)");
    expect(first.permissions?.allow).toContain("Skill(mate-react-doctor)");
    expect(first.permissions?.allow).not.toContain("Bash(npx react-doctor:*)");
    expect(
      first.permissions?.allow?.some((entry) => /^Bash\(.*react-doctor[^:]*:\*\)$/.test(entry)),
    ).toBe(true);

    /** The launch wraps: Capability hooks and the prepare hook live in the repository. */
    const workingRepoSettings = JSON.parse(
      await fs.readFile(path.join(scenario.working, ".claude", "settings.local.json"), "utf8"),
    ) as ClaudeSettings & { permissions?: { additionalDirectories?: string[] } };
    expect(workingRepoSettings.permissions?.additionalDirectories).toEqual([scenario.companion]);
    expect(hasCommand(workingRepoSettings.hooks?.Stop, "react-doctor.sh")).toBe(false);
    expect(hasCommand(workingRepoSettings.hooks?.SessionStart, "session-prepare")).toBe(true);

    /** ...so the launch's derived settings omit the wrap-carried group. */
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    const derived = JSON.parse(
      await fs.readFile(invocation.argv[invocation.argv.indexOf("--settings") + 1]!, "utf8"),
    ) as ClaudeSettings;
    expect(hasCommand(derived.hooks?.SessionStart, "session-prepare")).toBe(false);

    const exclude = await fs.readFile(
      path.join(scenario.working, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).toContain("/.claude/");

    // A second launch must converge on the same content — no duplicated hooks or
    // allow entries.
    expect((await launch()).exitCode).toBe(0);
    const second = await fs.readFile(settingsPath, "utf8");
    expect(second).toBe(JSON.stringify(first, null, 2) + "\n");
  });

  for (const testCase of [
    {
      tool: "claude" as const,
      allowedAgents: undefined,
      setupSelections: {
        allowedAgents: ["claude"],
        capabilities: ["openspec", "react-doctor"],
      },
      launchArgs: ["claude", "--print", "hello"],
    },
    {
      tool: "opencode" as const,
      allowedAgents: ["opencode"],
      setupSelections: { allowedAgents: ["opencode"], capabilities: ["openspec"] },
      launchArgs: ["opencode", "--mode", "chat"],
    },
  ]) {
    test(
      `launch spawns ${testCase.tool} directly with no Mate-supplied base URL`,
      async () => {
        const scenario = await createScenario(`mate-cli-e2e-direct-launch-${testCase.tool}-`);
        const capturePath = await writeAdapterStub(scenario, testCase.tool);

        expect((await setupCompanion(scenario, [], testCase.setupSelections)).exitCode).toBe(0);
        expect((await linkRepository(scenario)).exitCode).toBe(0);

        const result = await runMate(scenario, {
          cwd: scenario.working,
          args: testCase.launchArgs,
          input: "y\n",
          env: {
            MATE_E2E_CAPTURE_PATH: capturePath,
            ANTHROPIC_BASE_URL: "",
            OPENAI_BASE_URL: "",
          },
        });

        expect(result.exitCode).toBe(0);

        const invocation = await readJson<{
          cwd: string;
          argv: string[];
          env: {
            ANTHROPIC_BASE_URL: string | null;
            OPENAI_BASE_URL: string | null;
            OPENCODE_CONFIG_CONTENT: string | null;
            PATH: string | null;
            MATE_ARTIFACT_PATH: string | null;
            MATE_REPO_PATH: string | null;
          };
        }>(capturePath);

        expect(invocation.cwd).toBe(scenario.working);
        expect(invocation.env.MATE_ARTIFACT_PATH).toBe(scenario.companion);
        expect(invocation.env.MATE_REPO_PATH).toBe(scenario.working);
        expect(invocation.env.ANTHROPIC_BASE_URL).toBe("");
        expect(invocation.env.OPENAI_BASE_URL).toBe("");
        if (invocation.env.OPENCODE_CONFIG_CONTENT) {
          expect(JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT).provider).toBeUndefined();
        }
      },
      /** setup + link + launch; 30s also lets the runMate watchdog fire first and dump output. */
      { timeout: 30000 },
    );
  }

  test("a direct launch starts in a TTY and consumes --yes", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-tty-");
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
      args: ["claude", "--", "--yes", "--print", "hello"],
      inputChunks: [],
      env: { MATE_E2E_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Continue? [y/N]");
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).not.toContain("--yes");
    expect(invocation.argv).toContain("hello");
  });
});
