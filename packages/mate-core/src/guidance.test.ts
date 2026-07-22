import { describe, expect, test } from "bun:test";

import {
  CODEBASE_EXPLORATION_MARKER,
  COMPANION_POLICY_MARKER,
  GUIDANCE_FILE_VERSION,
  parseGuidanceContent,
  validateGuidanceData,
} from "./guidance";
import { MATE_ENV } from "./env";

const validGuidance = {
  version: 1,
  companionGuidance: `${COMPANION_POLICY_MARKER}framework="mate">policy</companion-policy>`,
  codebaseExplorationGuidance: `${CODEBASE_EXPLORATION_MARKER}priority="mandatory">rules</codebase-exploration-rules>`,
  errors: [],
};

describe("guidance contract constants", () => {
  test("delivery variable and version are stable", () => {
    expect(MATE_ENV.guidanceJson).toBe("MATE_GUIDANCE_JSON");
    expect(GUIDANCE_FILE_VERSION).toBe(1);
  });
});

describe("validateGuidanceData", () => {
  test("accepts a valid guidance payload", () => {
    const result = validateGuidanceData(validGuidance);

    expect(result.errors).toEqual([]);
    expect(result.guidance.companionGuidance).toBe(validGuidance.companionGuidance);
    expect(result.guidance.codebaseExplorationGuidance).toBe(
      validGuidance.codebaseExplorationGuidance,
    );
  });

  test("accepts empty codebase exploration guidance", () => {
    const result = validateGuidanceData({
      ...validGuidance,
      codebaseExplorationGuidance: "",
    });

    expect(result.errors).toEqual([]);
  });

  test("rejects a non-object payload", () => {
    expect(validateGuidanceData(null).errors).toEqual(["guidance data is not a JSON object"]);
    expect(validateGuidanceData([]).errors).toEqual(["guidance data is not a JSON object"]);
    expect(validateGuidanceData("guidance").errors).toEqual(["guidance data is not a JSON object"]);
  });

  test("rejects an unsupported version", () => {
    const result = validateGuidanceData({ ...validGuidance, version: 2 });

    expect(result.errors).toContain("unsupported guidance data version");
  });

  test("rejects missing companion guidance", () => {
    const missing = validateGuidanceData({ ...validGuidance, companionGuidance: undefined });
    const empty = validateGuidanceData({ ...validGuidance, companionGuidance: "   " });

    expect(missing.errors).toContain("missing injected companion guidance");
    expect(empty.errors).toContain("missing injected companion guidance");
  });

  test("rejects companion guidance without the policy marker", () => {
    const result = validateGuidanceData({
      ...validGuidance,
      companionGuidance: "plain guidance without marker",
    });

    expect(result.errors).toContain("injected companion guidance is malformed");
  });

  test("rejects missing codebase exploration guidance field", () => {
    const result = validateGuidanceData({
      ...validGuidance,
      codebaseExplorationGuidance: undefined,
    });

    expect(result.errors).toContain("missing injected codebase exploration guidance");
  });

  test("rejects non-empty codebase exploration guidance without its marker", () => {
    const result = validateGuidanceData({
      ...validGuidance,
      codebaseExplorationGuidance: "rules without marker",
    });

    expect(result.errors).toContain("injected codebase exploration guidance is malformed");
  });

  test("carries embedded generation errors through", () => {
    const result = validateGuidanceData({
      ...validGuidance,
      errors: ["companion guidance was not injected", "", 42],
    });

    expect(result.errors).toEqual(["companion guidance was not injected"]);
  });
});

describe("parseGuidanceContent", () => {
  test("parses and validates valid JSON content", () => {
    const result = parseGuidanceContent(JSON.stringify(validGuidance));

    expect(result.errors).toEqual([]);
    expect(result.guidance.version).toBe(1);
  });

  test("reports invalid JSON without throwing", () => {
    const result = parseGuidanceContent("{not json");

    expect(result.errors).toEqual(["guidance data is not valid JSON"]);
    expect(result.guidance.companionGuidance).toBe("");
  });
});
