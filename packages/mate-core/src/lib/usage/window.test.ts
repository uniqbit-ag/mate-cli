import { describe, expect, test } from "bun:test";

import { unknownUsageMetrics } from "./types";
import { inUsageWindow, usageDates, usageDays, usageWindow } from "./window";

describe("usage window", () => {
  test("uses seven UTC calendar days across month boundaries", () => {
    const window = usageWindow(7, new Date("2026-03-02T23:30:00-05:00"));
    expect(window).toEqual({
      start: "2026-02-25T00:00:00.000Z",
      endExclusive: "2026-03-04T00:00:00.000Z",
      timezone: "UTC",
      days: 7,
    });
    expect(usageDates(window)).toHaveLength(7);
    expect(inUsageWindow(window.start, window)).toBe(true);
    expect(inUsageWindow(window.endExclusive, window)).toBe(false);
    expect(inUsageWindow("invalid", window)).toBe(false);
  });

  test("accepts only bounded whole days", () => {
    for (const value of ["7x", "1.5", 0, -1, 366, undefined, "", Infinity]) {
      expect(() => usageDays(value)).toThrow("integer from 1 through 365");
    }
    expect(usageDays("30")).toBe(30);
    expect(usageWindow(1, new Date("2024-02-29T12:00:00Z")).start).toBe("2024-02-29T00:00:00.000Z");
  });

  test("retains unknowns independently of measured zero", () => {
    const metrics = unknownUsageMetrics();
    expect(metrics.totalTokens).toBeNull();
    expect(metrics.cost.amount).toBeNull();
    metrics.totalTokens = 0;
    expect(metrics.totalTokens).toBe(0);
    expect(unknownUsageMetrics().totalTokens).toBeNull();
  });
});
