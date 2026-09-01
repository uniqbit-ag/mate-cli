import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import {
  collectCcusageSpending,
  collectRTKSavings,
  collectTokenSaveSavings,
  mergeResults,
} from "./collector";

const makeSpawn =
  (stdout: string, status = 0) =>
  () =>
    ({ stdout, status, error: null }) as ReturnType<typeof spawnSync>;

const REPORT_NOW = new Date("2026-08-31T12:00:00Z");

const epochDay = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

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
      spawn: (..._args: Parameters<typeof spawnSync>) => {
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
  test("aggregates history from the inclusive report cutoff", async () => {
    const calls: string[][] = [];
    const deps = {
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return {
          stdout: JSON.stringify([
            { day: epochDay("2026-08-23"), saved_tokens: 100, calls: 1, usd: 1 },
            { day: epochDay("2026-08-24"), saved_tokens: 200, calls: 2, usd: 2 },
            { day: epochDay("2026-08-25"), saved_tokens: 300, calls: 3, usd: 3 },
          ]),
          status: 0,
          error: null,
        } as ReturnType<typeof spawnSync>;
      },
      now: () => REPORT_NOW,
    };
    const result = await collectTokenSaveSavings("/tmp/repo", 7, deps);
    expect(result.entry).not.toBeNull();
    expect(calls).toEqual([["tokensave", "gain", "--history", "--json", "--range", "all"]]);
    expect(result.entry!.tokensSaved).toBe(500);
    expect(result.entry!.calls).toBe(5);
    expect(result.entry!.costSaved).toBe(5);
    expect(result.entry!.efficiency).toBe("100/call");
    expect(result.status.enabled).toBe(true);
  });

  test("does not request an unsupported arbitrary range", async () => {
    const calls: string[][] = [];
    const result = await collectTokenSaveSavings("/tmp/repo", 31, {
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return {
          stdout: JSON.stringify([]),
          status: 0,
          error: null,
        } as ReturnType<typeof spawnSync>;
      },
      now: () => REPORT_NOW,
    });
    expect(calls[0]).toEqual(["tokensave", "gain", "--history", "--json", "--range", "all"]);
    expect(result.status.status).toBe("no data");
  });

  test("returns no window data when history misses the report period", async () => {
    const result = await collectTokenSaveSavings("/tmp/repo", 7, {
      spawn: makeSpawn(
        JSON.stringify([{ day: epochDay("2026-08-23"), saved_tokens: 100, calls: 1, usd: 1 }]),
      ),
      now: () => REPORT_NOW,
    });
    expect(result.entry).toBeNull();
    expect(result.status.status).toBe("no window data");
  });

  test("returns no data for an empty or malformed history", async () => {
    const empty = await collectTokenSaveSavings("/tmp/repo", 7, {
      spawn: makeSpawn("[]"),
    });
    const malformed = await collectTokenSaveSavings("/tmp/repo", 7, {
      spawn: makeSpawn("not json"),
    });
    expect(empty.status.status).toBe("no data");
    expect(malformed.status.status).toBe("no data");
  });

  test("returns disabled when command fails", async () => {
    const deps = { spawn: makeSpawn("", 1) };
    const result = await collectTokenSaveSavings("/tmp/repo", 7, deps);
    expect(result.entry).toBeNull();
    expect(result.status.enabled).toBe(false);
  });
});

describe("collectRTKSavings", () => {
  test("aggregates daily data from the inclusive report cutoff", async () => {
    const calls: string[][] = [];
    const deps = {
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return {
          stdout: JSON.stringify({
            summary: { total_saved: 90000, total_commands: 90 },
            daily: [
              { date: "2026-08-23", saved_tokens: 100, commands: 1 },
              { date: "2026-08-24", saved_tokens: 200, commands: 2 },
              { date: "2026-08-25", saved_tokens: 300, commands: 3 },
            ],
          }),
          status: 0,
          error: null,
        } as ReturnType<typeof spawnSync>;
      },
      now: () => REPORT_NOW,
    };
    const result = await collectRTKSavings("/tmp/repo", 7, deps);
    expect(result.entry).not.toBeNull();
    expect(calls).toEqual([["rtk", "gain", "--project", "--daily", "--format", "json"]]);
    expect(result.entry!.tool).toBe("rtk");
    expect(result.entry!.tokensSaved).toBe(500);
    expect(result.entry!.calls).toBe(5);
    expect(result.status.enabled).toBe(true);
  });

  test("returns no data for malformed or empty daily data", async () => {
    const malformed = await collectRTKSavings("/tmp/repo", 7, {
      spawn: makeSpawn("not json"),
    });
    const empty = await collectRTKSavings("/tmp/repo", 7, {
      spawn: makeSpawn(JSON.stringify({ daily: [] })),
    });
    expect(malformed.status.status).toBe("no data");
    expect(empty.status.status).toBe("no data");
  });

  test("returns no window data when daily data misses the report period", async () => {
    const result = await collectRTKSavings("/tmp/repo", 7, {
      spawn: makeSpawn(JSON.stringify({ daily: [{ date: "2026-08-23", saved_tokens: 100 }] })),
      now: () => REPORT_NOW,
    });
    expect(result.entry).toBeNull();
    expect(result.status.status).toBe("no window data");
  });

  test("returns disabled when binary missing", async () => {
    const deps = {
      spawn: () =>
        ({ stdout: "", status: null, error: new Error("ENOENT") }) as ReturnType<typeof spawnSync>,
    };
    const result = await collectRTKSavings("/tmp/repo", 7, deps);
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
    );
    expect(result.spending).toHaveLength(2);
    expect(result.totalSpending).toBe(1.5);
    expect(result.savings).toHaveLength(2);
    expect(result.savings[0].tool).toBe("tokensave");
    expect(result.savings[0].tokensSaved).toBe(1500);
    expect(result.savings[0].calls).toBe(8);
    expect(result.savings[0].costSaved).toBe(0.8);
    expect(result.savings[1].tool).toBe("rtk");
    expect(result.totalSavings).toBeCloseTo(0.8);
    expect(result.netSpend).toBeCloseTo(0.7);
  });

  test("handles empty inputs", () => {
    const result = mergeResults([], null, null, null);
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
    );
    expect(result.savings).toHaveLength(1);
    expect(result.savings[0].tokensSaved).toBe(1000);
  });
});
