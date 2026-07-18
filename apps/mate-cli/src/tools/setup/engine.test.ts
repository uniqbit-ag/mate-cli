import { describe, expect, mock, test } from "bun:test";

import { buildSetupInstallationPlan, executeSetupInstallationPlan } from "./engine";
import type { CapabilityPlugin, Plugin, SetupContext } from "./plugin";

function makePlugin(id: string, kind: Plugin["kind"], enabled = true): Plugin {
  return {
    id,
    kind,
    label: id,
    description: "",
    defaultSelected: false,
    isEnabled: () => enabled,
    async apply() {},
    async teardown() {},
  };
}

describe("setup engine", () => {
  test("buildSetupInstallationPlan preserves phase and registration order", () => {
    const plugins: Plugin[] = [
      makePlugin("provider-a", "provider"),
      makePlugin("provider-b", "provider", false),
      makePlugin("pm-a", "packageManager"),
      makePlugin("cap-a", "capability"),
      makePlugin("integration-a", "integration", false),
      makePlugin("root-a", "root"),
    ];

    const plan = buildSetupInstallationPlan(
      { profiles: { default: { name: "default", allowedAgents: ["provider-a"] } } },
      plugins,
    );

    expect(plan.activeProviders).toEqual(["provider-a"]);
    expect(
      plan.actions.map((action) => `${action.phase}:${action.pluginId}:${action.action}`),
    ).toEqual([
      "provider:provider-a:apply",
      "provider:provider-b:teardown",
      "packageManager:pm-a:apply",
      "capability:cap-a:apply",
      "integration:integration-a:teardown",
      "root:root-a:apply",
    ]);
  });

  test("executeSetupInstallationPlan captures skipped actions, warnings, and provider teardowns", async () => {
    const applyMock = mock(async () => {});
    const teardownMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("tokensave", "capability"),
      requires: { packageManagers: ["uv"] },
      forProvider: {
        claude: {
          apply: applyMock,
          teardown: teardownMock,
        },
      },
    };
    const provider = {
      ...makePlugin("claude", "provider"),
      isEnabled: () => true,
    };
    const ctx: SetupContext = {
      companionPath: "/tmp/companion",
      config: { profiles: { default: { name: "default", allowedAgents: ["claude"] } } },
      mode: "setup",
      activeProviders: ["claude"],
    };

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const plan = buildSetupInstallationPlan(ctx.config, [provider, capability]);
      const outcome = await executeSetupInstallationPlan(ctx, [provider, capability], plan);

      expect(outcome.skippedActions).toHaveLength(1);
      expect(outcome.skippedActions[0]).toEqual(
        expect.objectContaining({ pluginId: "tokensave", action: "teardown" }),
      );
      expect(outcome.executedActions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pluginId: "claude", action: "apply" }),
          expect.objectContaining({ pluginId: "tokensave", action: "teardown" }),
          expect.objectContaining({
            pluginId: "tokensave",
            providerId: "claude",
            action: "teardown",
          }),
        ]),
      );
      expect(teardownMock).toHaveBeenCalledTimes(1);
      expect(applyMock).not.toHaveBeenCalled();
      expect(outcome.warnings).toEqual([
        "tokensave capability disabled: requires uv package manager",
      ]);
      expect(stderrChunks.join("")).toContain(
        "tokensave capability disabled: requires uv package manager",
      );
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
