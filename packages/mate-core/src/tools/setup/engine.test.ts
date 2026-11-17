import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, mock, test } from "bun:test";

import { buildSetupInstallationPlan, executeSetupInstallationPlan } from "./engine";
import type {
  CapabilityPlugin,
  Plugin,
  PluginLifecycle,
  ProviderPlugin,
  SetupContext,
} from "./plugin";

function makeCtx(
  config: SetupContext["config"],
  mode: SetupContext["mode"] = "setup",
): SetupContext {
  return {
    companionPath: "/tmp/companion",
    config,
    mode,
    activeProviders: [],
    scope: "companion",
  };
}

function makeLifecycle(overrides: Partial<PluginLifecycle> = {}): PluginLifecycle {
  return { apply: async () => {}, teardown: async () => {}, ...overrides };
}

function makePlugin<K extends Plugin["kind"]>(
  id: string,
  kind: K,
  enabled = true,
): Plugin & { kind: K } {
  return {
    id,
    kind,
    label: id,
    description: "",
    defaultSelected: false,
    isEnabled: () => enabled,
    lifecycle: { companion: makeLifecycle() },
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
      scope: "companion",
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
      lifecycle: {
        companion: makeLifecycle({
          async apply(ctx) {
            appliedPaths.push(ctx.companionPath);
          },
        }),
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

  test("hub-scope apply action calls lifecycle.hub, not lifecycle.companion", async () => {
    const applyMock = mock(async () => {});
    const applyHubMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability"),
      lifecycle: {
        companion: makeLifecycle({ apply: applyMock }),
        hub: makeLifecycle({ apply: applyHubMock }),
      },
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

  test("hub-scope teardown action calls lifecycle.hub, not lifecycle.companion", async () => {
    const teardownMock = mock(async () => {});
    const teardownHubMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability", false),
      lifecycle: {
        companion: makeLifecycle({ teardown: teardownMock }),
        hub: makeLifecycle({ teardown: teardownHubMock }),
      },
    };
    const config = { allowedAgents: [] };
    const ctx: SetupContext = { ...makeCtx(config), scope: "hub" };

    const plan = buildSetupInstallationPlan(config, [capability]);
    await executeSetupInstallationPlan(ctx, [capability], plan);

    expect(teardownHubMock).toHaveBeenCalledTimes(1);
    expect(teardownMock).not.toHaveBeenCalled();
  });

  test("hub-scope action for a capability without lifecycle.hub calls nothing", async () => {
    const applyMock = mock(async () => {});
    const teardownMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability"),
      lifecycle: { companion: { apply: applyMock, teardown: teardownMock } },
    };
    const config = { allowedAgents: [] };
    const ctx: SetupContext = { ...makeCtx(config), scope: "hub" };

    const plan = buildSetupInstallationPlan(config, [capability]);
    const outcome = await executeSetupInstallationPlan(ctx, [capability], plan);

    expect(applyMock).not.toHaveBeenCalled();
    expect(teardownMock).not.toHaveBeenCalled();
    expect(outcome.executedActions).toEqual([]);
  });

  test("companion-scope dispatch never calls lifecycle.hub", async () => {
    const applyMock = mock(async () => {});
    const applyHubMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability"),
      lifecycle: {
        companion: makeLifecycle({ apply: applyMock }),
        hub: makeLifecycle({ apply: applyHubMock }),
      },
    };
    const config = { allowedAgents: [] };
    const ctx = makeCtx(config);

    const plan = buildSetupInstallationPlan(config, [capability]);
    await executeSetupInstallationPlan(ctx, [capability], plan);

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyHubMock).not.toHaveBeenCalled();
  });

  test("forProvider action stays skipped in hub scope even when the capability declares lifecycle.hub", async () => {
    const providerApplyMock = mock(async () => {});
    const applyHubMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      ...makePlugin("hub-cap", "capability"),
      lifecycle: { hub: makeLifecycle({ apply: applyHubMock }) },
      forProvider: {
        claude: {
          apply: providerApplyMock,
          teardown: mock(async () => {}),
        },
      },
    };
    const provider: Plugin = {
      ...makePlugin("claude", "provider"),
      lifecycle: { hub: makeLifecycle() },
    };
    const config = { allowedAgents: ["claude"] };
    const ctx: SetupContext = { ...makeCtx(config), scope: "hub", activeProviders: ["claude"] };

    const plan = buildSetupInstallationPlan(config, [provider, capability]);
    await executeSetupInstallationPlan(ctx, [provider, capability], plan);

    expect(providerApplyMock).not.toHaveBeenCalled();
    expect(applyHubMock).toHaveBeenCalledTimes(1);
  });

  test("hub scope applies a root plugin only through lifecycle.hub", async () => {
    const hubApplyMock = mock(async () => {});
    const companionOnlyApplyMock = mock(async () => {});
    const hubRoot: Plugin = {
      ...makePlugin("hub-root", "root"),
      lifecycle: { hub: makeLifecycle({ apply: hubApplyMock }) },
    };
    const companionRoot: Plugin = {
      ...makePlugin("companion-root", "root"),
      lifecycle: { companion: makeLifecycle({ apply: companionOnlyApplyMock }) },
    };
    const config = { allowedAgents: [] };
    const ctx: SetupContext = { ...makeCtx(config), scope: "hub" };

    const plan = buildSetupInstallationPlan(config, [hubRoot, companionRoot]);
    await executeSetupInstallationPlan(ctx, [hubRoot, companionRoot], plan);

    expect(hubApplyMock).toHaveBeenCalledTimes(1);
    expect(companionOnlyApplyMock).not.toHaveBeenCalled();
  });

  test("companion scope removes MCP servers of a plugin that no longer declares lifecycle.companion", async () => {
    const companionPath = await fs.mkdtemp(path.join(os.tmpdir(), "mate-engine-mcp-"));
    try {
      const unregister = mock(async (_ctx: SetupContext, _name: string) => {});
      const provider: ProviderPlugin = {
        ...makePlugin("claude", "provider"),
        hosting: { mcp: { register: async () => {}, unregister } },
      };
      const registering: CapabilityPlugin = {
        ...makePlugin("acme", "capability"),
        lifecycle: {
          companion: makeLifecycle({
            async apply(ctx) {
              await ctx.mcp?.register({ name: "acme", command: "acme" });
            },
          }),
        },
      };
      const withoutCompanion: CapabilityPlugin = { ...registering, lifecycle: {} };
      const config = { allowedAgents: ["claude"] };
      const ctx: SetupContext = { ...makeCtx(config), companionPath, activeProviders: ["claude"] };

      for (const capability of [registering, withoutCompanion]) {
        const plugins = [provider, capability];
        await executeSetupInstallationPlan(
          ctx,
          plugins,
          buildSetupInstallationPlan(config, plugins),
        );
      }

      expect(unregister).toHaveBeenCalledTimes(1);
      expect(unregister.mock.calls[0]?.[1]).toBe("acme");
    } finally {
      await fs.rm(companionPath, { recursive: true, force: true });
    }
  });
});

describe("registration policy enforcement", () => {
  const emptyConfig = { allowedAgents: [] };

  test("required plugin applies despite deselection and never receives teardown", async () => {
    const applyMock = mock(async () => {});
    const teardownMock = mock(async () => {});
    const capability: Plugin = {
      ...makePlugin("locked-cap", "capability", false),
      lifecycle: { companion: { apply: applyMock, teardown: teardownMock } },
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
      lifecycle: { companion: makeLifecycle({ apply: applyMock }) },
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
      lifecycle: { companion: makeLifecycle({ teardown: teardownMock }) },
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
