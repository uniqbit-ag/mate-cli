import { describe, expect, mock, test } from "bun:test";

import { buildSetupInstallationPlan, executeSetupInstallationPlan } from "./engine";
import type { CapabilityPlugin, Plugin, SetupContext } from "./plugin";

function makeCtx(
  config: SetupContext["config"],
  mode: SetupContext["mode"] = "setup",
): SetupContext {
  return {
    companionPath: "/tmp/companion",
    config,
    mode,
    activeProviders: [],
  };
}

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

    const plan = buildSetupInstallationPlan({ allowedAgents: ["provider-a"] }, plugins);

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
      config: { allowedAgents: ["claude"] },
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

  test("hub setup actions receive only the hub root", async () => {
    const appliedPaths: string[] = [];
    const hub = "/tmp/hub";
    const child = `${hub}/companions/acme`;
    const rootPlugin: Plugin = {
      ...makePlugin("root", "root"),
      async apply(ctx) {
        appliedPaths.push(ctx.companionPath);
      },
    };
    const config = {
      type: "hub" as const,
      hub: {
        companions: [
          {
            id: "acme",
            path: "companions/acme",
            source: { kind: "local" as const, path: child },
          },
        ],
      },
      allowedAgents: [],
    };
    const plan = buildSetupInstallationPlan(config, [rootPlugin]);

    await executeSetupInstallationPlan(
      { ...makeCtx(config), companionPath: hub },
      [rootPlugin],
      plan,
    );

    expect(appliedPaths).toEqual([hub]);
    expect(appliedPaths).not.toContain(child);
  });

  test("hub-scope apply action calls applyHub, not apply", async () => {
    const applyMock = mock(async () => {});
    const applyHubMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability"),
      apply: applyMock,
      applyHub: applyHubMock,
    };
    const config = { allowedAgents: [] };
    const ctx: SetupContext = { ...makeCtx(config), scope: "hub" };

    const plan = buildSetupInstallationPlan(config, [capability]);
    const outcome = await executeSetupInstallationPlan(ctx, [capability], plan);

    expect(applyHubMock).toHaveBeenCalledTimes(1);
    expect(applyMock).not.toHaveBeenCalled();
    expect(outcome.executedActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ pluginId: "hub-cap", action: "apply" })]),
    );
  });

  test("hub-scope teardown action calls teardownHub, not teardown", async () => {
    const teardownMock = mock(async () => {});
    const teardownHubMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability", false),
      teardown: teardownMock,
      teardownHub: teardownHubMock,
    };
    const config = { allowedAgents: [] };
    const ctx: SetupContext = { ...makeCtx(config), scope: "hub" };

    const plan = buildSetupInstallationPlan(config, [capability]);
    await executeSetupInstallationPlan(ctx, [capability], plan);

    expect(teardownHubMock).toHaveBeenCalledTimes(1);
    expect(teardownMock).not.toHaveBeenCalled();
  });

  test("hub-scope action for a capability declaring neither hook calls nothing", async () => {
    const applyMock = mock(async () => {});
    const teardownMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability"),
      apply: applyMock,
      teardown: teardownMock,
    };
    const config = { allowedAgents: [] };
    const ctx: SetupContext = { ...makeCtx(config), scope: "hub" };

    const plan = buildSetupInstallationPlan(config, [capability]);
    const outcome = await executeSetupInstallationPlan(ctx, [capability], plan);

    expect(applyMock).not.toHaveBeenCalled();
    expect(teardownMock).not.toHaveBeenCalled();
    expect(outcome.executedActions).toEqual([]);
  });

  test("companion-scope dispatch never calls applyHub/teardownHub", async () => {
    const applyMock = mock(async () => {});
    const applyHubMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability"),
      apply: applyMock,
      applyHub: applyHubMock,
    };
    const config = { allowedAgents: [] };
    const ctx = makeCtx(config);

    const plan = buildSetupInstallationPlan(config, [capability]);
    await executeSetupInstallationPlan(ctx, [capability], plan);

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyHubMock).not.toHaveBeenCalled();
  });

  test("forProvider action stays skipped in hub scope even when the capability declares applyHub", async () => {
    const providerApplyMock = mock(async () => {});
    const applyHubMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability"),
      applyHub: applyHubMock,
      forProvider: {
        claude: {
          apply: providerApplyMock,
          teardown: mock(async () => {}),
        },
      },
    };
    const provider = { ...makePlugin("claude", "provider"), isEnabled: () => true };
    const config = { allowedAgents: ["claude"] };
    const ctx: SetupContext = { ...makeCtx(config), scope: "hub", activeProviders: ["claude"] };

    const plan = buildSetupInstallationPlan(config, [provider, capability]);
    await executeSetupInstallationPlan(ctx, [provider, capability], plan);

    expect(providerApplyMock).not.toHaveBeenCalled();
    expect(applyHubMock).toHaveBeenCalledTimes(1);
  });
});

describe("registration policy enforcement", () => {
  const emptyConfig = { allowedAgents: [] };

  test("required plugin applies despite deselection and never receives teardown", async () => {
    const applyMock = mock(async () => {});
    const teardownMock = mock(async () => {});
    const capability: Plugin = {
      ...makePlugin("locked-cap", "capability", false),
      apply: applyMock,
      teardown: teardownMock,
    };
    const entries = [{ plugin: capability, policy: "required" as const }];

    const plan = buildSetupInstallationPlan(emptyConfig, entries);
    await executeSetupInstallationPlan(makeCtx(emptyConfig), entries, plan);

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(teardownMock).not.toHaveBeenCalled();
  });

  test("required plugin re-applies in sync mode", async () => {
    const applyMock = mock(async () => {});
    const capability: Plugin = {
      ...makePlugin("locked-cap", "capability", false),
      apply: applyMock,
    };
    const entries = [{ plugin: capability, policy: "required" as const }];

    const plan = buildSetupInstallationPlan(emptyConfig, entries);
    await executeSetupInstallationPlan(makeCtx(emptyConfig, "sync"), entries, plan);

    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  test("optional plugin keeps the existing isEnabled dispatch", async () => {
    const teardownMock = mock(async () => {});
    const capability: Plugin = {
      ...makePlugin("opt-cap", "capability", false),
      teardown: teardownMock,
    };
    const entries = [{ plugin: capability, policy: "optional" as const }];

    const plan = buildSetupInstallationPlan(emptyConfig, entries);
    await executeSetupInstallationPlan(makeCtx(emptyConfig), entries, plan);

    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  test("required provider counts as an active provider", () => {
    const provider = makePlugin("locked-provider", "provider", false);
    const plan = buildSetupInstallationPlan(emptyConfig, [
      { plugin: provider, policy: "required" },
    ]);
    expect(plan.activeProviders).toEqual(["locked-provider"]);
  });
});
