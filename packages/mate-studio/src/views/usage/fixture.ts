import type { CompanionUsageSnapshot, UsageMetrics } from "@uniqbit/mate-core/studio";

const metrics = (tokens: number): UsageMetrics => ({
  inputTokens: tokens / 2,
  outputTokens: tokens / 4,
  cacheReadTokens: tokens / 4,
  cacheWriteTokens: 0,
  totalTokens: tokens,
  cost: { amount: tokens / 1000, currency: "USD", basis: "estimated" },
  savings: {
    estimatedTokens: tokens * 2,
    calls: 10,
    estimatedCost: { amount: null, currency: null, basis: "unknown" },
  },
  coverage: { tokens: "complete", cost: "complete", savings: "complete" },
});

/** Synthetic usage for component tests; never reads runtime stores. */
export function usageFixture(): CompanionUsageSnapshot {
  const repositories = ["companion", "web", "api"].map((id, index) => {
    const values = metrics((index + 1) * 100);
    return {
      id: `acme-${id}`,
      kind: index === 0 ? ("companion" as const) : ("working" as const),
      label: index === 0 ? "Companion Repository" : `acme/${id}`,
      metrics: values,
      daily: [{ date: "2026-11-07", metrics: values }],
      breakdowns: [{ runtime: "claude" as const, model: "acme-model", metrics: values }],
      sources: [{ repositoryId: `acme-${id}`, name: "claude" as const, status: "ok" as const }],
    };
  });
  return {
    kind: "companion-usage",
    version: 1,
    companion: { id: "acme-companion" },
    collectedAt: "2026-11-07T12:00:00Z",
    window: {
      start: "2026-11-01T00:00:00Z",
      endExclusive: "2026-11-08T00:00:00Z",
      days: 7,
      timezone: "UTC",
    },
    repositories,
    totals: metrics(600),
    daily: [{ date: "2026-11-07", metrics: metrics(600) }],
    breakdowns: [],
    sources: repositories.flatMap((row) => row.sources),
    warnings: [],
  };
}
