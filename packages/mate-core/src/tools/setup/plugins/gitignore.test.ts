import { describe, expect, test } from "bun:test";

import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import type { SetupContext } from "../plugin";
import { collectManagedGitignoreEntries } from "./gitignore";

function makeContext(config: Partial<FrameworkConfig>): SetupContext {
  return {
    companionPath: "/companion",
    mode: "sync",
    activeProviders: [],
    config: {
      profiles: { default: { name: "default", allowedAgents: [] } },
      ...config,
    },
  };
}

describe("collectManagedGitignoreEntries with declared plugins", () => {
  test("ignores the local override file and installed trees, never the pin file", () => {
    const entries = collectManagedGitignoreEntries(
      makeContext({ plugins: [{ package: "@acme/custom-plugin", version: "^1.0.0" }] }),
      [],
    );

    expect(entries).toContain(".mate/config/plugins.local.yaml");
    expect(entries).toContain(".mate/dependencies/plugins/");
    expect(entries.some((entry) => entry.includes("plugins.lock.yaml"))).toBe(false);
  });

  test("contributes nothing without declared plugins", () => {
    expect(collectManagedGitignoreEntries(makeContext({}), [])).toEqual([]);
  });
});
