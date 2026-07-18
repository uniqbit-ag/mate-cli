import { describe, expect, test } from "bun:test";
import { formatCost, formatPercentage, formatTokens } from "./formatter";

describe("formatTokens", () => {
  test("formats small numbers as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(100)).toBe("100");
    expect(formatTokens(999)).toBe("999");
  });

  test("formats thousands with K suffix", () => {
    expect(formatTokens(1_000)).toBe("1.0K");
    expect(formatTokens(1_500)).toBe("1.5K");
    expect(formatTokens(999_999)).toBe("1000.0K");
  });

  test("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(12_345_678)).toBe("12.3M");
  });
});

describe("formatCost", () => {
  test("formats with dollar sign and two decimals", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(42.5)).toBe("$42.50");
    expect(formatCost(1234.567)).toBe("$1234.57");
  });
});

describe("formatPercentage", () => {
  test("formats with one decimal and percent sign", () => {
    expect(formatPercentage(0)).toBe("0.0%");
    expect(formatPercentage(50)).toBe("50.0%");
    expect(formatPercentage(33.333)).toBe("33.3%");
  });
});
