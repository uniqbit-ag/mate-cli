import type { CompanionUsageSnapshot, UsageCost, UsageMetrics } from "@uniqbit/mate-core/studio";

export const SOURCE_LABELS = {
  claude: "Claude Code",
  opencode: "OpenCode",
  tokensave: "TokenSave",
  rtk: "RTK",
};
export const tokens = (value: number | null, compact = false): string =>
  value === null
    ? "—"
    : new Intl.NumberFormat(
        "en",
        compact ? { notation: "compact", maximumFractionDigits: 1 } : {},
      ).format(value);
export const cost = (value: UsageCost): string =>
  value.amount === null || !value.currency
    ? "—"
    : new Intl.NumberFormat("en", {
        style: "currency",
        currency: value.currency,
        maximumFractionDigits: 2,
      }).format(value.amount);
export const dayLabel = (date: string, year = false): string =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  }).format(new Date(date));

export function coverageLabel(metrics: UsageMetrics): string {
  if (metrics.totalTokens === null && metrics.savings.estimatedTokens === null)
    return "Unavailable";
  return metrics.coverage.tokens !== "complete" || metrics.coverage.cost !== "complete"
    ? "Partial"
    : "Complete";
}

export function usageSelection(snapshot: CompanionUsageSnapshot, repositoryId?: string) {
  const repository = snapshot.repositories.find((row) => row.id === repositoryId);
  return repository
    ? {
        metrics: repository.metrics,
        daily: repository.daily,
        sources: repository.sources,
        repositories: [repository],
        repositoryId: repository.id,
      }
    : {
        metrics: snapshot.totals,
        daily: snapshot.daily,
        sources: snapshot.sources,
        repositories: snapshot.repositories,
        repositoryId: undefined,
      };
}
