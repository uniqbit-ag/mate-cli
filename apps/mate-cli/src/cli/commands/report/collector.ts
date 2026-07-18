import { spawnSync } from "node:child_process";

import type { SavingsEntry, SpendingEntry, ToolStatus } from "./types";

export interface CollectorDeps {
  spawn?: typeof spawnSync;
}

function spawnCmd(cmd: string, args: string[], opts: { cwd: string }, deps: CollectorDeps) {
  const spawn = deps.spawn ?? spawnSync;
  return spawn(cmd, args, { ...opts, encoding: "utf-8", timeout: 60_000 });
}

function parseJson<T>(output: string): T | null {
  try {
    const trimmed = output.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// ccusage JSON: { daily: [{ period, totalCost, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelBreakdowns: [{ modelName, cost, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }] }], totals: { totalCost, totalTokens, ... } }
export async function collectCcusageSpending(
  days: number,
  deps: CollectorDeps = {},
): Promise<{ entries: SpendingEntry[]; status: ToolStatus; friendlyError?: string }> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  // Try bunx first, then npx
  const runners = [
    { cmd: "bunx", args: ["ccusage@latest", "--json", "--since", sinceStr] },
    { cmd: "npx", args: ["ccusage@latest", "--json", "--since", sinceStr] },
  ];

  for (const runner of runners) {
    const result = spawnCmd(runner.cmd, runner.args, { cwd: process.cwd() }, deps);
    if (result.error || result.status !== 0) continue;

    const data = parseJson<{
      daily?: Array<{
        modelBreakdowns?: Array<{
          modelName: string;
          cost: number;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
        }>;
      }>;
    }>(result.stdout);

    if (!data || !data.daily || data.daily.length === 0) continue;

    // Aggregate model breakdowns across all days
    const modelMap = new Map<string, SpendingEntry>();
    for (const day of data.daily) {
      for (const mb of day.modelBreakdowns ?? []) {
        const existing = modelMap.get(mb.modelName) ?? {
          model: mb.modelName,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        };
        existing.inputTokens += mb.inputTokens ?? 0;
        existing.outputTokens += mb.outputTokens ?? 0;
        existing.cacheReadTokens += mb.cacheReadTokens ?? 0;
        existing.cacheWriteTokens += mb.cacheCreationTokens ?? 0;
        existing.cost += mb.cost ?? 0;
        modelMap.set(mb.modelName, existing);
      }
    }

    const entries = Array.from(modelMap.values()).toSorted((a, b) => b.cost - a.cost);

    return {
      entries,
      status: { name: "ccusage", enabled: true, status: "ok" },
    };
  }

  // All runners failed
  return {
    entries: [],
    status: { name: "ccusage", enabled: false, status: "not installed" },
    friendlyError:
      "ccusage is not installed. Install it to get token spending data:\n" +
      "  npm install -g ccusage\n" +
      "  bun install -g ccusage\n" +
      "  npx ccusage@latest",
  };
}

// tokensave gain JSON: { saved_tokens, calls, usd }
export async function collectTokenSaveSavings(
  repoPath: string,
  days: number,
  deps: CollectorDeps = {},
): Promise<{ entry: SavingsEntry | null; status: ToolStatus }> {
  const result = spawnCmd(
    "tokensave",
    ["gain", "--json", "--range", `${days}d`],
    { cwd: repoPath },
    deps,
  );

  if (result.error || result.status !== 0) {
    return {
      entry: null,
      status: { name: "tokensave", enabled: false, status: "not enabled" },
    };
  }

  const data = parseJson<{ saved_tokens?: number; calls?: number; usd?: number }>(result.stdout);
  if (!data) {
    return {
      entry: null,
      status: { name: "tokensave", enabled: false, status: "no data" },
    };
  }

  return {
    entry: {
      tool: "tokensave",
      tokensSaved: data.saved_tokens ?? 0,
      calls: data.calls ?? 0,
      costSaved: data.usd ?? 0,
      efficiency:
        (data.calls ?? 0) > 0
          ? `${formatEfficiency(data.saved_tokens ?? 0, data.calls ?? 0)}`
          : "N/A",
    },
    status: { name: "tokensave", enabled: true, status: "ok" },
  };
}

// rtk gain JSON: { summary: { total_saved, total_commands, avg_savings_pct } }
export async function collectRTKSavings(
  repoPath: string,
  deps: CollectorDeps = {},
): Promise<{ entry: SavingsEntry | null; status: ToolStatus }> {
  const result = spawnCmd(
    "rtk",
    ["gain", "--project", "--format", "json"],
    { cwd: repoPath },
    deps,
  );

  if (result.error || result.status !== 0) {
    return {
      entry: null,
      status: { name: "rtk", enabled: false, status: "not installed" },
    };
  }

  const data = parseJson<{
    summary?: { total_saved?: number; total_commands?: number; avg_savings_pct?: number };
  }>(result.stdout);
  if (!data || !data.summary) {
    return {
      entry: null,
      status: { name: "rtk", enabled: false, status: "no data" },
    };
  }

  const s = data.summary;
  return {
    entry: {
      tool: "rtk",
      tokensSaved: s.total_saved ?? 0,
      calls: s.total_commands ?? 0,
      costSaved: 0,
      efficiency:
        (s.total_commands ?? 0) > 0
          ? `${formatEfficiency(s.total_saved ?? 0, s.total_commands ?? 0)}`
          : "N/A",
    },
    status: { name: "rtk", enabled: true, status: "ok" },
  };
}

// headroom savings JSON: { windows: { last_7_days: { tokens_saved, cost_usd, calls } } }
export async function collectHeadroomSavings(
  days: number,
  deps: CollectorDeps = {},
): Promise<{ entry: SavingsEntry | null; status: ToolStatus }> {
  const result = spawnCmd(
    "headroom",
    ["savings", "--json", "--days", String(days)],
    { cwd: process.cwd() },
    deps,
  );

  if (result.error || result.status !== 0) {
    return {
      entry: null,
      status: { name: "headroom", enabled: false, status: "not enabled" },
    };
  }

  const data = parseJson<{
    windows?: Record<string, { tokens_saved?: number; cost_usd?: number; calls?: number }>;
  }>(result.stdout);
  if (!data || !data.windows) {
    return {
      entry: null,
      status: { name: "headroom", enabled: false, status: "no data" },
    };
  }

  const key = `last_${days}_days`;
  const window = data.windows[key] ?? data.windows["last_7_days"] ?? data.windows["all_time"];
  if (!window) {
    return {
      entry: null,
      status: { name: "headroom", enabled: false, status: "no window data" },
    };
  }

  return {
    entry: {
      tool: "headroom",
      tokensSaved: window.tokens_saved ?? 0,
      calls: window.calls ?? 0,
      costSaved: window.cost_usd ?? 0,
      efficiency:
        (window.calls ?? 0) > 0
          ? `${formatEfficiency(window.tokens_saved ?? 0, window.calls ?? 0)}`
          : "N/A",
    },
    status: { name: "headroom", enabled: true, status: "ok" },
  };
}

function formatEfficiency(tokensSaved: number, calls: number): string {
  const perCall = tokensSaved / calls;
  if (perCall >= 1_000_000) {
    return `${(perCall / 1_000_000).toFixed(1)}M/call`;
  }
  if (perCall >= 1_000) {
    return `${(perCall / 1_000).toFixed(1)}K/call`;
  }
  return `${Math.round(perCall)}/call`;
}

export function mergeResults(
  ccusageEntries: SpendingEntry[],
  tokensaveWorking: SavingsEntry | null,
  tokensaveCompanion: SavingsEntry | null,
  rtkEntry: SavingsEntry | null,
  headroomEntry: SavingsEntry | null,
): {
  spending: SpendingEntry[];
  savings: SavingsEntry[];
  totalSpending: number;
  totalSavings: number;
  netSpend: number;
} {
  const totalSpending = ccusageEntries.reduce((sum, e) => sum + e.cost, 0);

  // Merge tokensave entries from working + companion repos into one row
  let mergedTokensave: SavingsEntry | null = null;
  if (tokensaveWorking || tokensaveCompanion) {
    const totalTokens =
      (tokensaveWorking?.tokensSaved ?? 0) + (tokensaveCompanion?.tokensSaved ?? 0);
    const totalCalls = (tokensaveWorking?.calls ?? 0) + (tokensaveCompanion?.calls ?? 0);
    const totalCost = (tokensaveWorking?.costSaved ?? 0) + (tokensaveCompanion?.costSaved ?? 0);
    mergedTokensave = {
      tool: "tokensave",
      tokensSaved: totalTokens,
      calls: totalCalls,
      costSaved: totalCost,
      efficiency: totalCalls > 0 ? formatEfficiency(totalTokens, totalCalls) : "N/A",
    };
  }

  const savings: SavingsEntry[] = [mergedTokensave, rtkEntry, headroomEntry].filter(
    Boolean,
  ) as SavingsEntry[];
  const totalSavings = savings.reduce((sum, e) => sum + e.costSaved, 0);

  return {
    spending: ccusageEntries,
    savings,
    totalSpending,
    totalSavings,
    netSpend: totalSpending - totalSavings,
  };
}
