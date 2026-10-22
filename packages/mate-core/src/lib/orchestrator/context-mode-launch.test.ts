import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import { createContextModePlugin } from "../../tools/setup/capabilities/context-mode";
import { createClaudePlugin } from "../../tools/setup/providers/claude";
import { PluginRegistry } from "../../tools/setup/registry";
import { CONTEXT_MODE_VERSION, getContextModePackageRoot } from "../context-mode-package";
import { getClaudePluginRoot } from "../package-paths";
import { ClaudeAdapter } from "./adapters/claude";
import { prepareSession } from "./session-prepare";

const tempRoots: string[] = [];

afterEach(async () => {
  resetActiveDistribution();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A companion with context-mode enabled and its package installed, as setup leaves it. */
async function contextModeCompanion(): Promise<string> {
  const companionPath = await fs.mkdtemp(path.join(os.tmpdir(), "mate-context-mode-launch-"));
  tempRoots.push(companionPath);
  const root = getContextModePackageRoot(companionPath);
  for (const asset of [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "skills/context-mode/SKILL.md",
    "build/adapters/opencode/plugin.js",
  ]) {
    await fs.mkdir(path.dirname(path.join(root, asset)), { recursive: true });
    await fs.writeFile(path.join(root, asset), "{}\n");
  }
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "context-mode", version: CONTEXT_MODE_VERSION }),
  );
  return companionPath;
}

describe("a Claude launch with context-mode enabled", () => {
  test("passes the Mate plugin and then the context-mode plugin", async () => {
    const companionPath = await contextModeCompanion();
    const config = { allowedAgents: ["claude"], capabilities: [{ name: "context-mode" }] };
    setActiveDistribution({
      config: { runtime: "bun", version: "1.0.0" },
      registry: new PluginRegistry([createClaudePlugin(), createContextModePlugin()]),
    });

    const prepared = await prepareSession({
      runtime: "claude",
      companionPath,
      mode: "attended",
      config,
      skipGit: true,
    });
    expect(prepared.ok).toBe(true);

    const adapter = new ClaudeAdapter();
    const launch = await adapter.planLaunch(
      {
        launchWorkingDirectory: companionPath,
        allowedAgents: config.allowedAgents,
        companionPath,
        capabilities: config.capabilities,
      },
      prepared,
    );
    const args = adapter.buildArgs(launch, []);

    expect(args.filter((arg) => arg === "--plugin-dir")).toHaveLength(2);
    expect(args.filter((_, index) => args[index - 1] === "--plugin-dir")).toEqual([
      getClaudePluginRoot(),
      getContextModePackageRoot(companionPath),
    ]);
  });
});
