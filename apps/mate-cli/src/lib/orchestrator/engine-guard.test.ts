import { describe, expect, test } from "bun:test";

import { checkMateEngineRequirement } from "./engine-guard";
import type { FrameworkConfig } from "./types";

function config(engines?: FrameworkConfig["engines"]): FrameworkConfig {
  return { profiles: {}, engines };
}

describe("checkMateEngineRequirement", () => {
  test("is a no-op when engines is absent", () => {
    expect(checkMateEngineRequirement(config(undefined), "0.14.3")).toEqual({ ok: true });
  });

  test("is a no-op when engines.mate is absent", () => {
    expect(checkMateEngineRequirement(config({}), "0.14.3")).toEqual({ ok: true });
  });

  test("passes when the current version satisfies the range", () => {
    const result = checkMateEngineRequirement(config({ mate: ">=0.14.0" }), "0.14.3");
    expect(result).toEqual({ ok: true });
  });

  test("fails with a reason when the current version does not satisfy the range", () => {
    const result = checkMateEngineRequirement(config({ mate: ">=99.0.0" }), "0.14.3");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(">=99.0.0");
    expect(result.reason).toContain("0.14.3");
  });

  test("fails with a distinct reason for an invalid range string", () => {
    const result = checkMateEngineRequirement(config({ mate: "not-a-range" }), "0.14.3");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not-a-range");
  });

  test("blocks a canary current version behind the required range", () => {
    const result = checkMateEngineRequirement(config({ mate: ">=0.15.0" }), "0.15.0-canary.1");
    expect(result.ok).toBe(false);
  });

  test("allows a canary current version ahead of the required range", () => {
    const result = checkMateEngineRequirement(config({ mate: ">=0.14.0" }), "0.15.0-canary.1");
    expect(result.ok).toBe(true);
  });
});
