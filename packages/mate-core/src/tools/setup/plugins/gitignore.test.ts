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
  test("ignores the local override file and the shared workspace's local .npmrc, never its manifest or lockfile", () => {
    const entries = collectManagedGitignoreEntries(
      makeContext({ plugins: [{ package: "@acme/custom-plugin", version: "^1.0.0" }] }),
      [],
    );

    expect(entries).toContain(".mate/config/plugins.local.yaml");
    expect(entries).toContain(".mate/plugins/.npmrc");
    expect(entries.some((entry) => entry.includes("plugins.lock.yaml"))).toBe(false);
    expect(entries.some((entry) => entry.includes("package.json"))).toBe(false);
    expect(entries.some((entry) => entry.includes("package-lock.json"))).toBe(false);
    // The workspace's node_modules is covered by the baseline node_modules/
    // rule below, not a plugin-specific entry.
    expect(entries.some((entry) => entry.includes("dependencies/plugins"))).toBe(false);
  });

  test("always contributes the node_modules and dependencies-tree baseline", () => {
    expect(collectManagedGitignoreEntries(makeContext({}), [])).toEqual([
      "node_modules/",
      ".mate/dependencies/*",
      ".mcp.json*",
    ]);
  });
});
