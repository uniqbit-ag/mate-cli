import { aggregateUsage } from "./aggregate";
import { collectClaudeUsage } from "./claude";
import { collectOpenCodeUsage } from "./opencode";
import { collectUsageSavings } from "./savings";
import type { UsageScope } from "./scope";
import { collectUsageJobs, sourceResult, type UsageCollection, type UsageCommand } from "./source";
import type { CompanionUsageSnapshot, UsageSourceName, UsageWindow } from "./types";

export interface UsageCollectorDeps {
  now?: () => Date;
  claudeProjects?: string;
  openCodeDatabase?: string;
  savingsDatabases?: Partial<Record<"tokensave" | "rtk", string>>;
  command?: UsageCommand;
  installed?: (name: string) => Promise<boolean>;
  collectors?: Partial<Record<UsageSourceName, (signal: AbortSignal) => Promise<UsageCollection>>>;
  timeoutMs?: number;
}

export async function collectCompanionUsage(
  scope: UsageScope,
  window: UsageWindow,
  deps: UsageCollectorDeps = {},
): Promise<CompanionUsageSnapshot> {
  const names = ["claude", "opencode", "tokensave", "rtk"] as const;
  const collectors = {
    claude: (signal: AbortSignal) => collectClaudeUsage(scope, window, signal, deps.claudeProjects),
    opencode: (signal: AbortSignal) =>
      collectOpenCodeUsage(scope, window, signal, {
        database: deps.openCodeDatabase,
        command: deps.command,
      }),
    tokensave: (signal: AbortSignal) =>
      collectUsageSavings("tokensave", scope, window, signal, {
        database: deps.savingsDatabases?.tokensave,
        command: deps.command,
        installed: deps.installed,
      }),
    rtk: (signal: AbortSignal) =>
      collectUsageSavings("rtk", scope, window, signal, {
        database: deps.savingsDatabases?.rtk,
        command: deps.command,
        installed: deps.installed,
      }),
    ...deps.collectors,
  };
  const results = await collectUsageJobs(
    names.map((name) => ({
      run: collectors[name],
      failed: (status) =>
        sourceResult(scope, name, status, [], "Local usage collection did not finish"),
    })),
    deps.timeoutMs,
  );
  return aggregateUsage(scope, window, results, (deps.now?.() ?? new Date()).toISOString());
}
