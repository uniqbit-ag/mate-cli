export type UsageCoverage = "complete" | "partial" | "unavailable";
export type UsageSourceName = "claude" | "opencode" | "tokensave" | "rtk";
export type UsageSourceStatus =
  | "ok"
  | "empty"
  | "disabled"
  | "unavailable"
  | "unsupported"
  | "error"
  | "timeout";

export interface UsageWindow {
  start: string;
  endExclusive: string;
  timezone: "UTC";
  days: number;
}

export interface UsageCost {
  amount: number | null;
  currency: string | null;
  basis: "reported" | "estimated" | "mixed" | "unknown";
}

export interface UsageMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  cost: UsageCost;
  savings: {
    estimatedTokens: number | null;
    calls: number | null;
    estimatedCost: UsageCost;
  };
  coverage: {
    tokens: UsageCoverage;
    cost: UsageCoverage;
    savings: UsageCoverage;
  };
}

export interface UsageSource {
  repositoryId: string;
  name: UsageSourceName;
  status: UsageSourceStatus;
  partial?: boolean;
  detail?: string;
}

export interface UsageDaily {
  date: string;
  metrics: UsageMetrics;
}

export interface UsageBreakdown {
  runtime: UsageSourceName;
  model: string;
  metrics: UsageMetrics;
}

export interface UsageGroup {
  metrics: UsageMetrics;
  daily: UsageDaily[];
  breakdowns: UsageBreakdown[];
  sources: UsageSource[];
}

export interface UsageRepository extends UsageGroup {
  id: string;
  kind: "companion" | "working";
  label: string;
}

export interface CompanionUsageSnapshot {
  kind: "companion-usage";
  version: 1;
  collectedAt: string;
  window: UsageWindow;
  companion: { id: string };
  repositories: UsageRepository[];
  totals: UsageMetrics;
  daily: UsageDaily[];
  breakdowns: UsageBreakdown[];
  sources: UsageSource[];
  warnings: string[];
}

export type UsageErrorCode =
  | "INVALID_OPTIONS"
  | "COMPANION_UNRESOLVED"
  | "COMPANION_AMBIGUOUS"
  | "COLLECTION_FAILED"
  | "PREFLIGHT_FAILED"
  | "INVALID_REPORT_INPUT"
  | "REPORT_DELIVERY_FAILED";

export interface UsageErrorEnvelope {
  kind: "error";
  version: 1;
  error: { code: UsageErrorCode; message: string; issues?: unknown };
  fallback?: unknown;
}

export type UsageResponse =
  | { snapshot: CompanionUsageSnapshot; error: null }
  | {
      snapshot: CompanionUsageSnapshot | null;
      error: Pick<UsageErrorEnvelope["error"], "code" | "message">;
    };

export class UsageError extends Error {
  constructor(
    readonly code: UsageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

/** Unknown is not a measured zero. */
export function unknownUsageMetrics(): UsageMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    cost: { amount: null, currency: null, basis: "unknown" },
    savings: {
      estimatedTokens: null,
      calls: null,
      estimatedCost: { amount: null, currency: null, basis: "unknown" },
    },
    coverage: {
      tokens: "unavailable",
      cost: "unavailable",
      savings: "unavailable",
    },
  };
}
