import { normalizeUsageRecords, type UsageRecord } from "./records";
import type { UsageScope } from "./scope";
import type { UsageCollection } from "./source";
import {
  unknownUsageMetrics,
  type CompanionUsageSnapshot,
  type UsageCost,
  type UsageCoverage,
  type UsageGroup,
  type UsageMetrics,
  type UsageSource,
  type UsageWindow,
} from "./types";
import { usageDates } from "./window";

const successful = (source: UsageSource) => source.status === "ok" || source.status === "empty";
const sum = (values: (number | null | undefined)[], emptyKnown: boolean): number | null => {
  const known = values.filter((value): value is number => typeof value === "number");
  if (known.length) return known.reduce((a, b) => a + b, 0);
  return emptyKnown ? 0 : null;
};

function coverage(
  sources: UsageSource[],
  values: (number | null | undefined)[],
  amount: number | null,
): UsageCoverage {
  if (amount === null) return "unavailable";
  const enabled = sources.filter((source) => source.status !== "disabled");
  return enabled.every((source) => successful(source) && !source.partial) &&
    values.every((value) => value !== null && value !== undefined)
    ? "complete"
    : "partial";
}

function costTotal(costs: (UsageCost | undefined)[], emptyKnown: boolean): UsageCost {
  const known = costs.filter(
    (cost): cost is UsageCost =>
      cost?.amount !== null && cost?.amount !== undefined && cost.currency !== null,
  );
  const currencies = new Set(known.map((cost) => cost.currency));
  if (currencies.size > 1) return { amount: null, currency: null, basis: "unknown" };
  if (!known.length)
    return {
      amount: emptyKnown ? 0 : null,
      currency: emptyKnown ? "USD" : null,
      basis: emptyKnown ? "reported" : "unknown",
    };
  const bases = new Set(known.map((cost) => cost.basis));
  return {
    amount: known.reduce((total, cost) => total + cost.amount!, 0),
    currency: known[0]!.currency,
    basis: bases.size === 1 ? known[0]!.basis : "mixed",
  };
}

function usageMetrics(records: UsageRecord[], sources: UsageSource[]): UsageMetrics {
  const metrics = unknownUsageMetrics();
  const spending = records.filter((record) => record.tokens);
  const savings = records.filter((record) => record.savings);
  const providers = sources.filter(
    (source) => source.name === "claude" || source.name === "opencode",
  );
  const savers = sources.filter((source) => source.name === "tokensave" || source.name === "rtk");
  const usageKnown = providers.some(successful) && spending.length === 0;
  const savingsKnown = savers.some(successful) && savings.length === 0;
  const tokenSum = (token: keyof NonNullable<UsageRecord["tokens"]>) =>
    sum(
      spending.map((record) => record.tokens![token]),
      usageKnown,
    );
  metrics.inputTokens = tokenSum("input");
  metrics.outputTokens = tokenSum("output");
  metrics.cacheReadTokens = tokenSum("cacheRead");
  metrics.cacheWriteTokens = tokenSum("cacheWrite");
  const tokenValues = spending.flatMap((record) => Object.values(record.tokens!));
  metrics.totalTokens = sum(tokenValues, usageKnown);
  metrics.cost = costTotal(
    spending.map((record) => record.cost),
    usageKnown,
  );
  metrics.savings.estimatedTokens = sum(
    savings.map((record) => record.savings!.tokens),
    savingsKnown,
  );
  metrics.savings.calls = sum(
    savings.map((record) => record.savings!.calls),
    savingsKnown,
  );
  metrics.savings.estimatedCost = costTotal(
    savings.map((record) => record.savings!.cost),
    false,
  );
  metrics.coverage = {
    tokens: coverage(providers, tokenValues, metrics.totalTokens),
    cost: coverage(
      providers,
      spending.map((record) => record.cost?.amount),
      metrics.cost.amount,
    ),
    savings: coverage(
      savers,
      savings.map((record) => record.savings!.tokens),
      metrics.savings.estimatedTokens,
    ),
  };
  return metrics;
}

function append(group: Map<string, UsageRecord[]>, key: string, record: UsageRecord): void {
  const entries = group.get(key);
  if (entries) entries.push(record);
  else group.set(key, [record]);
}

function usageGroup(
  records: UsageRecord[],
  sources: UsageSource[],
  window: UsageWindow,
): UsageGroup {
  const models = new Map<string, UsageRecord[]>();
  const days = new Map<string, UsageRecord[]>();
  for (const record of records) {
    append(models, `${record.source}\0${record.model}`, record);
    append(days, record.timestamp.slice(0, 10), record);
  }
  return {
    metrics: usageMetrics(records, sources),
    sources,
    daily: usageDates(window).map((date) => ({
      date,
      metrics: usageMetrics(days.get(date) ?? [], sources),
    })),
    breakdowns: [...models.values()]
      .map((entries) => ({
        runtime: entries[0]!.source,
        model: entries[0]!.model,
        metrics: usageMetrics(
          entries,
          sources.filter((source) => source.name === entries[0]!.source),
        ),
      }))
      .toSorted((a, b) => a.runtime.localeCompare(b.runtime) || a.model.localeCompare(b.model)),
  };
}

export function aggregateUsage(
  scope: UsageScope,
  window: UsageWindow,
  collections: UsageCollection[],
  collectedAt: string,
): CompanionUsageSnapshot {
  const normalized = normalizeUsageRecords(
    scope,
    window,
    collections.flatMap((collection) => collection.observations),
  );
  const { records, unattributed } = normalized;
  const attributed = new Set(records.map((record) => `${record.source}\0${record.repositoryId}`));
  const sources = collections
    .flatMap((collection) => collection.sources)
    .map((source): UsageSource => {
      const empty =
        source.status === "ok" && !attributed.has(`${source.name}\0${source.repositoryId}`);
      const status = empty ? "empty" : source.status;
      if (!unattributed.has(source.name)) return { ...source, status };
      const note = "Some records lack reliable repository attribution.";
      return {
        ...source,
        status,
        partial: true,
        detail: source.detail ? `${note} ${source.detail}` : note,
      };
    });
  const group = usageGroup(records, sources, window);
  return {
    kind: "companion-usage",
    version: 1,
    collectedAt,
    window,
    companion: { id: scope.companionId },
    repositories: scope.repositories.map((repository) => ({
      id: repository.id,
      kind: repository.kind,
      label: repository.label,
      ...usageGroup(
        records.filter((record) => record.repositoryId === repository.id),
        sources.filter((source) => source.repositoryId === repository.id),
        window,
      ),
    })),
    totals: group.metrics,
    daily: group.daily,
    breakdowns: group.breakdowns,
    sources,
    warnings: sources.some(
      (source) => (!successful(source) && source.status !== "disabled") || source.partial,
    )
      ? ["Local-source coverage is incomplete; known values are not a complete bill."]
      : [],
  };
}
