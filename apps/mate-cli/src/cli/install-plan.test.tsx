import { describe, expect, test } from "bun:test";

import { renderInstallExecution } from "./install-plan";

describe("renderInstallExecution", () => {
  test("renders execution and reports detected requirements as already installed", async () => {
    const execution = await renderInstallExecution({
      context: { kind: "core", config: {} as never, fingerprint: "context" },
      fingerprint: "requirements",
      requirements: [
        {
          id: "test:tool",
          label: "Test tool",
          group: "core",
          source: "test",
          command: "install test-tool",
          satisfied: true,
          detect: () => true,
          install: async () => {},
        },
      ],
    });

    expect(execution).toEqual({
      ok: true,
      results: [{ id: "test:tool", status: "skipped", verified: true }],
    });
  });
});
