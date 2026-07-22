import { describe, expect, test } from "bun:test";

import { buildOpenCodeGuidance } from "./opencode-guidance";

describe("buildOpenCodeGuidance", () => {
  test("includes the openspec-finish rule when the openspec capability is enabled", () => {
    const guidance = buildOpenCodeGuidance([{ name: "openspec" }]);

    expect(guidance.companionGuidance).toContain("openspec-finish");
    expect(guidance.errors).toEqual([]);
  });

  test("omits the openspec-finish rule when openspec is not enabled", () => {
    const guidance = buildOpenCodeGuidance([{ name: "tokensave" }]);

    expect(guidance.companionGuidance).not.toContain("openspec-finish");
  });

  test("delivers codebase exploration guidance as its own field, not embedded twice", () => {
    const guidance = buildOpenCodeGuidance([
      { name: "openspec" },
      { name: "tokensave" },
      { name: "react-doctor" },
    ]);

    // Must not be duplicated inside companionGuidance — it is a separate
    // MateGuidanceFile field, materialized separately by the plugin.
    expect(guidance.companionGuidance).not.toContain("<codebase-exploration-rules");
    expect(guidance.codebaseExplorationGuidance).toContain("<codebase-exploration-rules ");
    expect(guidance.codebaseExplorationGuidance).toContain("tokensave_context");
  });

  test("prefers graphify ordering in the separate field when both capabilities are enabled", () => {
    const guidance = buildOpenCodeGuidance([{ name: "graphify" }, { name: "tokensave" }]);

    expect(guidance.codebaseExplorationGuidance).toContain(
      "tokensave -> graphify -> grep/glob/read",
    );
  });

  test("leaves codebase exploration guidance empty without graphify or tokensave", () => {
    const guidance = buildOpenCodeGuidance([{ name: "openspec" }]);

    expect(guidance.codebaseExplorationGuidance).toBe("");
    expect(guidance.errors).toEqual([]);
  });

  test("produces valid guidance with no capabilities enabled", () => {
    const guidance = buildOpenCodeGuidance([]);

    expect(guidance.version).toBe(1);
    expect(guidance.companionGuidance).toContain("<companion-policy ");
    expect(guidance.companionGuidance).not.toContain("openspec-finish");
    expect(guidance.codebaseExplorationGuidance).toBe("");
    expect(guidance.errors).toEqual([]);
  });
});
