import { describe, expect, test } from "bun:test";

import { checkEngineRequirement } from "./engine-guard";
import type { FrameworkConfig } from "./types";

function config(engines?: FrameworkConfig["engines"]): FrameworkConfig {
  return { profiles: {}, engines };
}

describe("checkEngineRequirement", () => {
  test("is a no-op when engines is absent", () => {
    expect(checkEngineRequirement(config(undefined), "mate", "0.14.3")).toEqual({ ok: true });
  });

  test("is a no-op when no key matches the running distribution", () => {
    expect(checkEngineRequirement(config({}), "mate", "0.14.3")).toEqual({ ok: true });
  });

  test("ignores engines keys declared for other distributions", () => {
    const result = checkEngineRequirement(config({ mate: ">=99.0.0" }), "acme-mate", "1.0.0");
    expect(result).toEqual({ ok: true });
  });

  test("passes when the current version satisfies the range", () => {
    const result = checkEngineRequirement(config({ mate: ">=0.14.0" }), "mate", "0.14.3");
    expect(result).toEqual({ ok: true });
  });

  test("fails with a reason when the current version does not satisfy the range", () => {
    const result = checkEngineRequirement(config({ mate: ">=99.0.0" }), "mate", "0.14.3");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(">=99.0.0");
    expect(result.reason).toContain("0.14.3");
  });

  test("guards a custom distribution by its own key", () => {
    const result = checkEngineRequirement(config({ "acme-mate": ">=1.2.0" }), "acme-mate", "1.0.0");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(">=1.2.0");
    expect(result.reason).toContain("1.0.0");
  });

  test("fails with a distinct reason for an invalid range string", () => {
    const result = checkEngineRequirement(config({ mate: "not-a-range" }), "mate", "0.14.3");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not-a-range");
    expect(result.reason).toContain("invalid");
  });

  test("blocks a canary current version behind the required range", () => {
    const result = checkEngineRequirement(config({ mate: ">=0.15.0" }), "mate", "0.15.0-canary.1");
    expect(result.ok).toBe(false);
  });

  test("allows a canary current version ahead of the required range", () => {
    const result = checkEngineRequirement(config({ mate: ">=0.14.0" }), "mate", "0.15.0-canary.1");
    expect(result.ok).toBe(true);
  });
});
