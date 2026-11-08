import { UsageError, type UsageWindow } from "./types";

const DAY_MS = 86_400_000;

export function usageDays(value: unknown): number {
  const text = String(value);
  const days = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new UsageError("INVALID_OPTIONS", "days must be an integer from 1 through 365");
  }
  return days;
}

/** UTC calendar days, including today. */
export function usageWindow(days: number = 7, now: Date = new Date()): UsageWindow {
  days = usageDays(days);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!Number.isFinite(today)) throw new UsageError("INVALID_OPTIONS", "Invalid collection time");
  return {
    start: new Date(today - (days - 1) * DAY_MS).toISOString(),
    endExclusive: new Date(today + DAY_MS).toISOString(),
    timezone: "UTC",
    days,
  };
}

export function usageDates(window: UsageWindow): string[] {
  const start = Date.parse(window.start);
  return Array.from({ length: window.days }, (_, i) =>
    new Date(start + i * DAY_MS).toISOString().slice(0, 10),
  );
}

export function inUsageWindow(timestamp: string, window: UsageWindow): boolean {
  const time = Date.parse(timestamp);
  return time >= Date.parse(window.start) && time < Date.parse(window.endExclusive);
}
