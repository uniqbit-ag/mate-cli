import { expect, test } from "bun:test";

import { aggregateUsage } from "./aggregate";
import { collectUsageJobs, sourceResult } from "./source";
import type { UsageScope } from "./scope";
import { usageWindow } from "./window";

const scope: UsageScope = {
  companionPath: "/acme/companion",
  companionId: "companion",
  fingerprint: "acme",
  capabilities: [],
  repositories: [
    {
      id: "companion",
      kind: "companion",
      label: "Companion Repository",
      path: "/acme/companion",
      aliases: ["/acme/companion"],
      available: true,
    },
    {
      id: "web",
      kind: "working",
      label: "acme/web",
      path: "/acme/web",
      aliases: ["/acme/web", "/acme/worktree"],
      available: true,
    },
  ],
};
const window = usageWindow(7, new Date("2026-11-07T12:00:00Z"));

test("bounds concurrency, isolates errors/timeouts, and signals cancellation", async () => {
  let active = 0;
  let peak = 0;
  let aborted = false;
  const jobs = Array.from({ length: 8 }, () => ({
    run: async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return sourceResult(scope, "claude", "empty");
    },
    failed: (status: "error" | "timeout") => sourceResult(scope, "claude", status),
  }));
  jobs.push({
    run: async () => {
      throw new Error("private detail");
    },
    failed: (status) => sourceResult(scope, "claude", status),
  });
  jobs.push({
    run: async (signal?: AbortSignal) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
    failed: (status) => sourceResult(scope, "claude", status),
  });
  const results = await collectUsageJobs(jobs, 30);
  expect(peak).toBeLessThanOrEqual(4);
  expect(results[8]!.sources[0]!.status).toBe("error");
  expect(results[9]!.sources[0]!.status).toBe("timeout");
  expect(aborted).toBe(true);
});

test("keeps the records a job returns after its deadline aborts it", async () => {
  const kept = sourceResult(scope, "claude", "timeout", [
    {
      key: "acme-kept",
      source: "claude",
      directory: "/acme/web",
      timestamp: "2026-11-07T01:00:00Z",
      model: "acme-model",
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  ]);
  const [result] = await collectUsageJobs(
    [
      {
        run: (signal) =>
          new Promise((resolve) => signal.addEventListener("abort", () => resolve(kept))),
        failed: (status) => sourceResult(scope, "claude", status),
      },
    ],
    10,
  );
  expect(result).toBe(kept);
});

test("reconciles attributed records and keeps savings, unknown costs and incomplete coverage separate", () => {
  const claude = sourceResult(scope, "claude", "ok", [
    {
      key: "acme-event",
      source: "claude",
      directory: "/acme/web",
      timestamp: "2026-11-07T01:00:00Z",
      model: "acme-model",
      tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 },
    },
  ]);
  const saved = sourceResult(scope, "tokensave", "ok", [
    {
      key: "acme-saving",
      source: "tokensave",
      directory: "/acme/web",
      timestamp: "2026-11-07T01:00:00Z",
      model: "savings",
      savings: { tokens: 500, calls: 1 },
    },
  ]);
  const snapshot = aggregateUsage(
    scope,
    window,
    [
      claude,
      sourceResult(scope, "opencode", "unavailable"),
      saved,
      sourceResult(scope, "rtk", "disabled"),
    ],
    "2026-11-07T12:00:00Z",
  );
  expect(snapshot.totals.totalTokens).toBe(20);
  expect(snapshot.totals.cost.amount).toBeNull();
  expect(snapshot.totals.savings.estimatedTokens).toBe(500);
  expect(snapshot.totals.coverage.tokens).toBe("partial");
  expect(
    snapshot.repositories.reduce((total, repo) => total + (repo.metrics.totalTokens ?? 0), 0),
  ).toBe(20);
  expect(snapshot.daily.reduce((total, day) => total + (day.metrics.totalTokens ?? 0), 0)).toBe(20);
  expect(
    snapshot.breakdowns
      .filter((row) => row.runtime === "claude")
      .reduce((total, row) => total + (row.metrics.totalTokens ?? 0), 0),
  ).toBe(20);
  expect(snapshot.repositories[0]!.metrics.totalTokens).toBe(0);
});

test("all unavailable is not zero and currencies are never added together", () => {
  const none = aggregateUsage(
    scope,
    window,
    [sourceResult(scope, "claude", "unavailable"), sourceResult(scope, "opencode", "unavailable")],
    window.start,
  );
  expect(none.totals.totalTokens).toBeNull();
  const collections = ["USD", "EUR"].map((currency, i) =>
    sourceResult(scope, "claude", "ok", [
      {
        key: `acme-${i}`,
        source: "claude",
        directory: "/acme/web",
        timestamp: "2026-11-07T01:00:00Z",
        model: "acme-model",
        tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: { amount: 2, currency, basis: "reported" },
      },
    ]),
  );
  expect(aggregateUsage(scope, window, collections, window.start).totals.cost.amount).toBeNull();
});
