import fs from "node:fs";

import { describe, expect, spyOn, test } from "bun:test";

import { getClaudePluginRoot } from "../../../lib/package-paths";
import { runtimeClaudePluginRoot } from "../../../runtime/runtime-directory";
import {
  isMateGuardHookGroup,
  mateBannerHookGroups,
  mateGuardHookGroups,
  mateGuidanceHookGroups,
} from "./claude-plugin-hooks";
import type { ClaudeHookGroup } from "./claude-format";

function commands(groups: ClaudeHookGroup[]): string[] {
  return groups.flatMap((group) => (group.hooks ?? []).map((hook) => hook.command ?? ""));
}

describe("working-target plugin hook groups", () => {
  test("name the runtime link, never the install path", () => {
    const all = commands([
      ...mateGuardHookGroups(),
      ...mateGuidanceHookGroups(),
      ...mateBannerHookGroups(),
    ]);
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const command of all) {
      expect(command).toContain(runtimeClaudePluginRoot());
      expect(command).not.toContain(getClaudePluginRoot());
      expect(command).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    }
  });

  test("the guard is recognized in its runtime-link and install-path forms", () => {
    const [runtimeForm] = mateGuardHookGroups();
    const [installForm] = mateGuardHookGroups(getClaudePluginRoot());
    expect(isMateGuardHookGroup(runtimeForm!)).toBe(true);
    expect(isMateGuardHookGroup(installForm!)).toBe(true);
  });

  test("a group naming another root is not recognized", () => {
    const [foreign] = mateGuardHookGroups("/opt/acme/claude-plugin");
    expect(isMateGuardHookGroup(foreign!)).toBe(false);
  });

  test("repeated recognition reuses the own-group set instead of re-reading the plugin", () => {
    const [runtimeForm] = mateGuardHookGroups();
    isMateGuardHookGroup(runtimeForm!);
    const reads = spyOn(fs, "readFileSync");
    try {
      expect(isMateGuardHookGroup(runtimeForm!)).toBe(true);
      expect(isMateGuardHookGroup({ hooks: [{ command: "acme.sh" }] })).toBe(false);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });
});
