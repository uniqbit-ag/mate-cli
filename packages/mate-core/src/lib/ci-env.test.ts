import { describe, expect, test } from "bun:test";

import { isCiEnvironment } from "./ci-env";

describe("isCiEnvironment", () => {
  test("returns false when CI is unset", () => {
    expect(isCiEnvironment(undefined)).toBe(false);
  });

  test("returns false for explicitly disabled values", () => {
    expect(isCiEnvironment("")).toBe(false);
    expect(isCiEnvironment("0")).toBe(false);
    expect(isCiEnvironment("false")).toBe(false);
    expect(isCiEnvironment("FALSE")).toBe(false);
  });

  test("returns true for CI=1", () => {
    expect(isCiEnvironment("1")).toBe(true);
  });

  test("returns true for common CI provider values", () => {
    expect(isCiEnvironment("true")).toBe(true);
    expect(isCiEnvironment("gitlab")).toBe(true);
  });
});
