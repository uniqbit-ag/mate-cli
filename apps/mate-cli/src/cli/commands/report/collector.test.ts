import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  collectCcusageSpending,
  collectHeadroomSavings,
  collectRTKSavings,
  collectTokenSaveSavings,
  mergeResults,
} from "./collector";

const makeSpawn =
  (stdout: string, status = 0) =>
  (...args: Parameters<typeof spawnSync>) =>
    ({ stdout, status, error: null }) as ReturnType<typeof spawnSync>;

describe("collectCcusageSpending", () => {
  test("parses valid ccusage JSON response", async () => {
    const deps = {
      spawn: makeSpawn(
        JSON.stringify({
          daily: [
            {
              modelBreakdowns: [
                {
                  modelName: "claude-sonnet-5",
                  cost: 1.23,
                  inputTokens: 1000,
                  outputTokens: 500,
                  cacheReadTokens: 800,
                  cacheCreationTokens: 0,
                },
                {
                  modelName: "gpt-5.4",
                  cost: 0.5,
                  inputTokens: 500,
                  outputTokens: 200,
                  cacheReadTokens: 400,
                  cacheCreationTokens: 0,
                },
              ],
            },
            {
              modelBreakdowns: [
                {
                  modelName: "claude-sonnet-5",
                  cost: 2.0,
                  inputTokens: 2000,
                  outputTokens: 1000,
                  cacheReadTokens: 1500,
                  cacheCreationTokens: 100,
                },
              ],
            },
          ],
        }),
      ),
    };
    const result = await collectCcusageSpending(7, deps);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].model).toBe("claude-sonnet-5");
    expect(result.entries[0].cost).toBe(3.23);
    expect(result.entries[0].inputTokens).toBe(3000);
    expect(result.entries[0].cacheWriteTokens).toBe(100);
    expect(result.entries[1].model).toBe("gpt-5.4");
    expect(result.entries[1].cost).toBe(0.5);
    expect(result.status.enabled).toBe(true);
  });

  test("returns disabled status when bunx fails but npx succeeds", async () => {
    let callCount = 0;
    const deps = {
      spawn: (...args: Parameters<typeof spawnSync>) => {
        callCount++;
        if (callCount === 1) {
          return { stdout: "", status: 1, error: new Error("ENOENT") } as ReturnType<
            typeof spawnSync
          >;
        }
        return {
          stdout: JSON.stringify({
            daily: [
              {
                modelBreakdowns: [
                  {
                    modelName: "gpt-5.4",
                    cost: 0.5,
                    inputTokens: 100,
                    outputTokens: 50,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                  },
                ],
              },
            ],
          }),
          status: 0,
          error: null,
        } as ReturnType<typeof spawnSync>;
      },
    };
    const result = await collectCcusageSpending(7, deps);
    expect(result.entries).toHaveLength(1);
    expect(result.status.enabled).toBe(true);
  });

  test("returns disabled status when all runners fail", async () => {
    const deps = {
      spawn: () =>
        ({ stdout: "", status: 1, error: new Error("ENOENT") }) as ReturnType<typeof spawnSync>,
    };
    const result = await collectCcusageSpending(7, deps);
    expect(result.entries).toHaveLength(0);
    expect(result.status.enabled).toBe(false);
    expect(result.friendlyError).toContain("ccusage is not installed");
  });

  test("returns empty when JSON is invalid", async () => {
    const deps = { spawn: makeSpawn("not json") };
    const result = await collectCcusageSpending(7, deps);
    expect(result.entries).toHaveLength(0);
    expect(result.status.enabled).toBe(false);
  });

  test("returns empty when daily array is empty", async () => {
    const deps = { spawn: makeSpawn(JSON.stringify({ daily: [] })) };
    const result = await collectCcusageSpending(7, deps);
    expect(result.entries).toHaveLength(0);
    expect(result.status.enabled).toBe(false);
  });
});

describe("collectTokenSaveSavings", () => {
  test("parses valid JSON response", async () => {
    const deps = {
      spawn: makeSpawn(JSON.stringify({ saved_tokens: 50000, calls: 10, usd: 2.5 })),
    };
    const result = await collectTokenSaveSavings("/tmp/repo", 7, deps);
    expect(result.entry).not.toBeNull();
    expect(result.entry!.tokensSaved).toBe(50000);
    expect(result.entry!.calls).toBe(10);
    expect(result.status.enabled).toBe(true);
  });

  test("returns disabled when command fails", async () => {
    const deps = { spawn: makeSpawn("", 1) };
    const result = await collectTokenSaveSavings("/tmp/repo", 7, deps);
    expect(result.entry).toBeNull();
    expect(result.status.enabled).toBe(false);
  });
});

describe("collectRTKSavings", () => {
  test("parses valid JSON response", async () => {
    const deps = {
      spawn: makeSpawn(
        JSON.stringify({
          summary: { total_saved: 30000, total_commands: 5, avg_savings_pct: 15 },
        }),
      ),
    };
    const result = await collectRTKSavings("/tmp/repo", deps);
    expect(result.entry).not.toBeNull();
    expect(result.entry!.tool).toBe("rtk");
    expect(result.entry!.tokensSaved).toBe(30000);
    expect(result.status.enabled).toBe(true);
  });

  test("returns disabled when binary missing", async () => {
    const deps = {
      spawn: () =>
        ({ stdout: "", status: null, error: new Error("ENOENT") }) as ReturnType<typeof spawnSync>,
    };
    const result = await collectRTKSavings("/tmp/repo", deps);
    expect(result.status.enabled).toBe(false);
  });
});

describe("collectHeadroomSavings", () => {
  test("parses valid JSON response", async () => {
    const deps = {
      spawn: makeSpawn(
        JSON.stringify({
          windows: { last_7_days: { tokens_saved: 100000, calls: 20, cost_usd: 5.0 } },
        }),
      ),
    };
    const result = await collectHeadroomSavings(7, deps);
    expect(result.entry).not.toBeNull();
    expect(result.entry!.tool).toBe("headroom");
    expect(result.status.enabled).toBe(true);
  });

  test("returns disabled when command fails", async () => {
    const deps = { spawn: makeSpawn("", 1) };
    const result = await collectHeadroomSavings(7, deps);
    expect(result.entry).toBeNull();
    expect(result.status.enabled).toBe(false);
  });
});

describe("mergeResults", () => {
  test("merges spending from ccusage with savings", () => {
    const result = mergeResults(
      [
        {
          model: "claude-sonnet-5",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 800,
          cacheWriteTokens: 0,
          cost: 1.0,
        },
        {
          model: "gpt-5.4",
          inputTokens: 500,
          outputTokens: 200,
          cacheReadTokens: 400,
          cacheWriteTokens: 0,
          cost: 0.5,
        },
      ],
      { tool: "tokensave", tokensSaved: 1000, calls: 5, costSaved: 0.5, efficiency: "200/call" },
      { tool: "tokensave", tokensSaved: 500, calls: 3, costSaved: 0.3, efficiency: "166/call" },
      { tool: "rtk", tokensSaved: 30000, calls: 5, costSaved: 0, efficiency: "6000/call" },
      { tool: "headroom", tokensSaved: 5000, calls: 10, costSaved: 1.0, efficiency: "500/call" },
    );
    expect(result.spending).toHaveLength(2);
    expect(result.totalSpending).toBe(1.5);
    expect(result.savings).toHaveLength(3);
    expect(result.savings[0].tool).toBe("tokensave");
    expect(result.savings[0].tokensSaved).toBe(1500);
    expect(result.savings[0].calls).toBe(8);
    expect(result.savings[0].costSaved).toBe(0.8);
    expect(result.savings[1].tool).toBe("rtk");
    expect(result.savings[2].tool).toBe("headroom");
    expect(result.totalSavings).toBeCloseTo(1.8);
    expect(result.netSpend).toBeCloseTo(-0.3);
  });

  test("handles empty inputs", () => {
    const result = mergeResults([], null, null, null, null);
    expect(result.spending).toHaveLength(0);
    expect(result.savings).toHaveLength(0);
    expect(result.totalSpending).toBe(0);
    expect(result.totalSavings).toBe(0);
    expect(result.netSpend).toBe(0);
  });

  test("merges tokensave when only working repo has data", () => {
    const result = mergeResults(
      [],
      { tool: "tokensave", tokensSaved: 1000, calls: 5, costSaved: 0.5, efficiency: "200/call" },
      null,
      null,
      null,
    );
    expect(result.savings).toHaveLength(1);
    expect(result.savings[0].tokensSaved).toBe(1000);
  });
});
