import { describe, test, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import { runReportCommand } from "./index";

const COMPANION_PATH = "/tmp/test-companion";

beforeEach(async () => {
  await fs.mkdir(COMPANION_PATH, { recursive: true });
});

const makeResolveContext = () => ({
  configStore: {
    load: async () => ({
      capabilities: [{ name: "tokensave" }, { name: "headroom" }],
    }),
  },
  workingRepoStore: {
    load: async () => ({
      repos: [{ id: "test", path: "/tmp/test-work", profile: "default" }],
    }),
  },
  companionPath: "/tmp/test-companion",
});

const makeSpawn =
  (stdout: string, status = 0) =>
  (...args: Parameters<typeof spawnSync>) =>
    ({ stdout, status, error: null }) as ReturnType<typeof spawnSync>;

describe("runReportCommand", () => {
  test("generates report with mocked dependencies", async () => {
    const deps = {
      resolveFrameworkContext: makeResolveContext,
      spawn: makeSpawn(
        JSON.stringify({
          daily: [
            {
              modelBreakdowns: [
                {
                  modelName: "claude-sonnet-5",
                  cost: 1.0,
                  inputTokens: 1000,
                  outputTokens: 500,
                  cacheReadTokens: 800,
                  cacheCreationTokens: 0,
                },
              ],
            },
          ],
        }),
      ),
    };
    await runReportCommand([], deps);
    // Command should complete without throwing
  });

  test("supports --json flag", async () => {
    const deps = {
      resolveFrameworkContext: makeResolveContext,
      spawn: makeSpawn(
        JSON.stringify({
          daily: [{ modelBreakdowns: [] }],
        }),
      ),
    };
    await runReportCommand(["--json"], deps);
    // Command should complete without throwing
  });

  test("supports --days flag", async () => {
    const deps = {
      resolveFrameworkContext: makeResolveContext,
      spawn: makeSpawn(
        JSON.stringify({
          daily: [{ modelBreakdowns: [] }],
        }),
      ),
    };
    await runReportCommand(["--days", "30"], deps);
    // Command should complete without throwing
  });

  test("handles all tools disabled gracefully", async () => {
    const deps = {
      resolveFrameworkContext: () => ({
        configStore: { load: async () => ({ capabilities: [] }) },
        workingRepoStore: {
          load: async () => ({
            repos: [{ id: "test", path: "/tmp/test-work", profile: "default" }],
          }),
        },
        companionPath: "/tmp/test-companion",
      }),
      spawn: makeSpawn("", 1),
    };
    await runReportCommand([], deps);
    // Command should complete without throwing
  });
});
