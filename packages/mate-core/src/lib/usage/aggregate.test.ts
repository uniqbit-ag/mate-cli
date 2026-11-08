import { expect, test } from "bun:test";

import { aggregateUsage } from "./aggregate";
import type { UsageObservation } from "./records";
import type { UsageScope } from "./scope";
import { sourceResult } from "./source";
import { usageWindow } from "./window";

const repository = (id: string, available = true) => ({
  id,
  kind: "working" as const,
  label: `acme/${id}`,
  path: `/acme/${id}`,
  aliases: [`/acme/${id}`],
  available,
});
const scope: UsageScope = {
  companionPath: "/acme/companion",
  companionId: "companion",
  capabilities: [],
  fingerprint: "acme",
  repositories: [repository("web"), repository("api"), repository("gone", false)],
};
const window = usageWindow(7, new Date("2026-11-07T12:00:00Z"));
const observation = (
  key: string,
  directory: string,
  workingDirectory?: string,
): UsageObservation => ({
  key,
  source: "claude",
  directory,
  ...(workingDirectory ? { workingDirectory } : {}),
  timestamp: "2026-11-07T01:00:00Z",
  model: "acme-model",
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
});

test("unattributed records keep each row's detail and empty status", () => {
  const collection = sourceResult(
    scope,
    "claude",
    "ok",
    [observation("acme-web", "/acme/web"), observation("acme-lost", "acme-project", "/other")],
    "Pricing note.",
  );
  const snapshot = aggregateUsage(scope, window, [collection], window.start);
  const row = (id: string) => snapshot.sources.find((source) => source.repositoryId === id)!;
  expect(row("web")).toMatchObject({ status: "ok", partial: true });
  expect(row("web").detail).toContain("Pricing note.");
  expect(row("web").detail).toContain("lack reliable repository attribution");
  expect(row("api").status).toBe("empty");
  expect(row("gone")).toMatchObject({ status: "unavailable", partial: true });
  expect(row("gone").detail).toContain("Linked checkout is unavailable");
  expect(snapshot.daily.at(-1)!.metrics.totalTokens).toBe(2);
});

test("never infers dollar savings from priced or unpriced provider input", () => {
  const spend = (key: string, model: string, input: number): UsageObservation => ({
    ...observation(key, "/acme/web"),
    model,
    tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const saved = (key: string, directory: string, tokens: number): UsageObservation => ({
    key,
    source: "rtk",
    directory,
    timestamp: "2026-11-07T02:00:00Z",
    model: "savings",
    savings: { tokens, calls: 1 },
  });
  const savingScope = { ...scope, capabilities: ["rtk"] };
  const snapshot = aggregateUsage(
    savingScope,
    window,
    [
      sourceResult(savingScope, "claude", "ok", [
        spend("acme-sonnet", "claude-sonnet-4-5", 3_000_000),
        spend("acme-opus", "claude-opus-4-5", 1_000_000),
        spend("acme-unpriced", "acme-model", 9_000_000),
      ]),
      sourceResult(savingScope, "rtk", "ok", [
        saved("acme-web-saved", "/acme/web", 2_000_000),
        saved("acme-api-saved", "/acme/api", 1_000_000),
      ]),
    ],
    window.start,
  );
  const web = snapshot.repositories.find((row) => row.id === "web")!;
  const api = snapshot.repositories.find((row) => row.id === "api")!;
  expect(web.metrics.savings.estimatedCost).toEqual({
    amount: null,
    currency: null,
    basis: "unknown",
  });
  expect(api.metrics.savings.estimatedCost.amount).toBeNull();
  expect(snapshot.totals.savings.estimatedCost.amount).toBeNull();
  expect(snapshot.totals.savings.estimatedTokens).toBe(3_000_000);
  // Savings never change consumed tokens.
  expect(snapshot.totals.totalTokens).toBe(13_000_000);
});

test("preserves source-provided savings value and currency without repricing or changing usage", () => {
  const monetary = { amount: 2, currency: "EUR", basis: "estimated" as const };
  const snapshot = aggregateUsage(
    scope,
    window,
    [
      sourceResult(scope, "claude", "ok", [
        {
          ...observation("acme-priced", "/acme/web"),
          model: "claude-sonnet-4-6",
          cost: { amount: 0.5, currency: "USD", basis: "reported" },
        },
      ]),
      sourceResult(scope, "rtk", "ok", [
        {
          key: "acme-saved",
          source: "rtk",
          directory: "/acme/web",
          timestamp: "2026-11-07T02:00:00Z",
          model: "savings",
          savings: { tokens: 1_000_000, calls: 1, cost: monetary },
        },
      ]),
    ],
    window.start,
  );
  expect(snapshot.totals.savings.estimatedCost).toEqual(monetary);
  expect(snapshot.daily.at(-1)!.metrics.savings.estimatedCost).toEqual(monetary);
  expect(snapshot.repositories[0]!.metrics.savings.estimatedCost).toEqual(monetary);
  expect(snapshot.totals.cost.amount).toBe(0.5);
});
