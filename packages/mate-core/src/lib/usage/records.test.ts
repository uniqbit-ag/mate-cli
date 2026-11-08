import { expect, test } from "bun:test";

import { normalizeUsageRecords, nonnegative, type UsageObservation } from "./records";
import type { UsageScope } from "./scope";
import { usageWindow } from "./window";

const scope: UsageScope = {
  companionPath: "/acme/companion",
  companionId: "companion",
  capabilities: [],
  fingerprint: "acme",
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
      aliases: ["/acme/web", "/acme/web-worktree"],
      available: true,
    },
    {
      id: "api",
      kind: "working",
      label: "acme/api",
      path: "/acme/api",
      aliases: ["/acme/api"],
      available: true,
    },
  ],
};
const window = usageWindow(7, new Date("2026-11-07T12:00:00Z"));
const observation = (overrides: Partial<UsageObservation> = {}): UsageObservation => ({
  key: "event-acme",
  source: "opencode",
  directory: "/acme/web",
  timestamp: "2026-11-07T01:00:00Z",
  model: "acme-model",
  ...overrides,
});

test("deduplicates alias records and gives explicit working metadata precedence", () => {
  const result = normalizeUsageRecords(scope, window, [
    observation(),
    observation({ directory: "/acme/web-worktree" }),
    observation({ key: "projected", directory: "/acme/companion", workingDirectory: "/acme/api" }),
  ]);
  expect(result.records.map((record) => record.repositoryId)).toEqual(["web", "api"]);
  expect(result.unattributed.size).toBe(0);
});

test("excludes conflicting, ambiguous and unrelated activity and enforces the window", () => {
  const result = normalizeUsageRecords(scope, window, [
    observation(),
    observation({ directory: "/acme/api" }),
    observation({ key: "unrelated", directory: "/other/web" }),
    observation({ key: "ambiguous", directory: "web" }),
    observation({ key: "late", timestamp: window.endExclusive }),
    observation({ key: "invalid", timestamp: "not a date" }),
    observation({ key: "start", timestamp: window.start }),
  ]);
  expect(result.records.map((record) => record.key)).toEqual(["start"]);
  expect(result.unattributed.has("opencode")).toBe(true);
});

test("numbers stay unknown when malformed rather than coercing to measured zero", () => {
  expect(nonnegative(0)).toBe(0);
  for (const value of [undefined, null, "0", -1, NaN, Infinity])
    expect(nonnegative(value)).toBeNull();
});
