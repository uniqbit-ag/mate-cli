import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { withEnv } from "../../../test/helpers";
import {
  audienceLayerDir,
  audienceLayersRoot,
  currentAudienceLayer,
} from "../../runtime/audience-layer";
import { mateHome } from "../../runtime/runtime-directory";
import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import { ClaudeAdapter } from "../../lib/orchestrator/adapters/claude";
import { OpenCodeAdapter } from "../../lib/orchestrator/adapters/opencode";
import { sessionPrepareDeps, type PrepareResult } from "../../lib/orchestrator/session-prepare";
import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  withDocument,
} from "../../runtime/runtime-document-manifest";
import { wrapStateOf } from "../../runtime/wrap-state";
import { applySetupCompatibilities, renderWorkingRuntimeDocuments } from "../setup";
import {
  installFixturePackage,
  makeAudienceFixture,
  markerHitsInTree,
  markerHitsInValue,
  readTree,
  type AudienceFixture,
} from "./audience-isolation.fixture";
import { contributionLedgerPath, readContributionLedger } from "./contribution-ledger";
import { buildSetupInstallationPlan } from "./engine";
import {
  reconcileAudienceLayer,
  renderAudienceLayer,
  type AudienceLayerRequest,
  type RenderedAudienceLayer,
} from "./audience-layer";
import type { PluginRegistration, SetupContext } from "./plugin";
import { readOpenCodeAudienceLayer } from "./providers/opencode";
import { surfaceRoot } from "./surface-target";
import { PluginRegistry } from "./registry";

let fixture: AudienceFixture;

beforeEach(async () => {
  fixture = await makeAudienceFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("persisted passes are rendered from base registrations", () => {
  test("setup under an audience writes base only to the companion", async () => {
    await withEnv("MATE_AUDIENCE", "ba", () =>
      applySetupCompatibilities(
        fixture.companionPath,
        fixture.config,
        "setup",
        fixture.registrations(),
      ),
    );

    expect(await markerHitsInTree(fixture.companionPath, ["ba", "qa"])).toEqual([]);
    const baseHits = await markerHitsInTree(fixture.companionPath, ["base"]);
    for (const file of [
      ".mcp.json",
      "CLAUDE.md",
      "AGENTS.md",
      ".opencode/opencode.json",
      ".claude/settings.local.json",
    ]) {
      expect(baseHits).toContain(`${file}: base`);
    }
  });

  test("a companion sync during a launch writes base only", async () => {
    await withEnv("MATE_AUDIENCE", "ba", () =>
      applySetupCompatibilities(
        fixture.companionPath,
        fixture.config,
        "sync",
        fixture.registrations(),
        fixture.repoPath,
      ),
    );

    expect(await markerHitsInTree(fixture.companionPath, ["ba", "qa"])).toEqual([]);
    expect(await markerHitsInTree(fixture.repoPath, ["ba", "qa"])).toEqual([]);
  });

  test("the wrap renders base only, also for a bare prepare with a stray MATE_AUDIENCE", async () => {
    const rendered = await withEnv("MATE_AUDIENCE", "ba", () =>
      renderWorkingRuntimeDocuments(
        fixture.companionPath,
        fixture.config,
        fixture.repoPath,
        fixture.registrations(),
      ),
    );

    expect(markerHitsInValue("wrap", rendered.documents, ["ba", "qa"])).toEqual([]);
    expect(markerHitsInValue("wrap", rendered.documents, ["base"])).toEqual(["wrap: base"]);
  });
});

describe("audience plugins contribute declaratively only", () => {
  test("no plugin phase runs for an audience registration", async () => {
    const calls: string[] = [];
    const record = (name: string) => async () => {
      calls.push(name);
    };
    const registrations = fixture.registrations({
      base: { apply: record("base:apply") },
      ba: {
        apply: record("ba:apply"),
        teardown: record("ba:teardown"),
        forProvider: {
          claude: { apply: record("ba:claude:apply"), teardown: record("ba:claude:teardown") },
        },
      },
    });

    await applySetupCompatibilities(fixture.companionPath, fixture.config, "setup", registrations);

    expect(calls).toEqual(["base:apply"]);
  });

  test("the setup plan holds no action for an audience registration", () => {
    const plan = buildSetupInstallationPlan(fixture.config, fixture.registrations());
    const planned = new Set(plan.actions.map((action) => action.pluginId));
    expect(planned.has("ba-plugin")).toBe(false);
    expect(planned.has("qa-plugin")).toBe(false);
    expect(planned.has("base-plugin")).toBe(true);
  });

  test("an audience registration's launch preflight is not run", async () => {
    const ran: string[] = [];
    const preflight = (owner: string) => async () => {
      ran.push(owner);
      return [];
    };
    const noop = async () => {};
    setActiveDistribution({
      config: { runtime: "bun", version: "0.0.0" },
      registry: new PluginRegistry(
        fixture.registrations({
          base: {
            forProvider: { claude: { apply: noop, teardown: noop, preflight: preflight("base") } },
          },
          ba: {
            forProvider: { claude: { apply: noop, teardown: noop, preflight: preflight("ba") } },
          },
        }),
      ),
    });
    try {
      await sessionPrepareDeps.runCapabilityPreflight({
        companionPath: fixture.companionPath,
        config: fixture.config,
        providerId: "claude",
      });
    } finally {
      resetActiveDistribution();
    }
    expect(ran).toEqual(["base"]);
  });
});

describe("the contribution ledger tears down plugins a pass no longer reconciles", () => {
  /** What an older Mate did: an audience plugin rendered into the companion as if it were base. */
  function leakedRegistrations(owner: "ba" | "qa"): PluginRegistration[] {
    return fixture
      .registrations()
      .map((entry) =>
        "plugin" in entry && entry.audience === owner ? { ...entry, audience: null } : entry,
      );
  }

  test("an inactive audience's plugin is torn down, loaded or not", async () => {
    await applySetupCompatibilities(
      fixture.companionPath,
      fixture.config,
      "sync",
      leakedRegistrations("ba"),
    );
    expect(await markerHitsInTree(fixture.companionPath, ["ba"])).not.toEqual([]);
    const recorded = await readContributionLedger(fixture.companionPath);
    expect(recorded?.runtimes.claude?.["ba-plugin"]?.mcpServers).toEqual(["ba-mcp"]);

    // `ba` is not even registered now: only the ledger knows its entries.
    const withoutBa = fixture
      .registrations()
      .filter((entry) => !("plugin" in entry) || entry.audience !== "ba");
    await applySetupCompatibilities(fixture.companionPath, fixture.config, "sync", withoutBa);

    expect(await markerHitsInTree(fixture.companionPath, ["ba", "qa"])).toEqual([]);
    const ledger = await readContributionLedger(fixture.companionPath);
    expect(Object.keys(ledger?.runtimes.claude ?? {})).toEqual(["base-plugin"]);
    expect(Object.keys(ledger?.runtimes.opencode ?? {})).toEqual(["base-plugin"]);
  });

  test("a removed base declaration is torn down", async () => {
    await applySetupCompatibilities(
      fixture.companionPath,
      fixture.config,
      "sync",
      fixture.registrations(),
    );
    const withoutBase = fixture
      .registrations()
      .filter((entry) => !("plugin" in entry) || entry.plugin.id !== "base-plugin");
    await applySetupCompatibilities(fixture.companionPath, fixture.config, "sync", withoutBase);

    expect(await markerHitsInTree(fixture.companionPath, ["base", "ba", "qa"])).toEqual([]);
  });

  test("a user-authored MCP server the ledger does not record survives every pass", async () => {
    const mcpPath = path.join(fixture.companionPath, ".mcp.json");
    await fs.writeFile(
      mcpPath,
      JSON.stringify({ mcpServers: { "user-server": { command: "mine" } } }),
      "utf8",
    );

    await applySetupCompatibilities(
      fixture.companionPath,
      fixture.config,
      "sync",
      leakedRegistrations("ba"),
    );
    await applySetupCompatibilities(
      fixture.companionPath,
      fixture.config,
      "sync",
      fixture.registrations(),
    );

    const servers = JSON.parse(await fs.readFile(mcpPath, "utf8")).mcpServers;
    expect(Object.keys(servers).toSorted()).toEqual(["base-mcp", "user-server"]);
    expect(JSON.stringify(await readContributionLedger(fixture.companionPath))).not.toContain(
      "user-server",
    );
  });
});

describe("the upgrade sweep removes contributions that leaked before the ledger", () => {
  async function leakWithoutLedger(): Promise<void> {
    const leaked = fixture
      .registrations()
      .map((entry) =>
        "plugin" in entry && entry.audience !== undefined && entry.audience !== null
          ? { ...entry, audience: null }
          : entry,
      );
    await applySetupCompatibilities(fixture.companionPath, fixture.config, "sync", leaked);
    await fs.rm(contributionLedgerPath(fixture.companionPath));
    expect(await markerHitsInTree(fixture.companionPath, ["ba", "qa"])).not.toEqual([]);
  }

  function baseOnly(): PluginRegistration[] {
    return fixture.registrations().filter((entry) => !("plugin" in entry) || !entry.audience);
  }

  test("an audience plugin registered for the active audience is swept and a ledger written", async () => {
    await leakWithoutLedger();

    await applySetupCompatibilities(
      fixture.companionPath,
      fixture.config,
      "sync",
      fixture.registrations(),
    );

    expect(await markerHitsInTree(fixture.companionPath, ["ba", "qa"])).toEqual([]);
    const ledger = await readContributionLedger(fixture.companionPath);
    expect(ledger?.unswept).toBeUndefined();
    expect(Object.keys(ledger?.runtimes.claude ?? {})).toEqual(["base-plugin"]);
  });

  test("an unloadable audience plugin is reported, its guidance still removed, and the pass completes", async () => {
    await leakWithoutLedger();

    const outcome = await applySetupCompatibilities(
      fixture.companionPath,
      fixture.config,
      "sync",
      baseOnly(),
    );

    expect(outcome.warnings.some((warning) => warning.includes("@fixture/ba"))).toBe(true);
    const guidance = [
      await fs.readFile(path.join(fixture.companionPath, "CLAUDE.md"), "utf8"),
      await fs.readFile(path.join(fixture.companionPath, "AGENTS.md"), "utf8"),
    ].join("\n");
    expect(markerHitsInValue("guidance", guidance, ["ba", "qa"])).toEqual([]);
    expect(markerHitsInValue("guidance", guidance, ["base"])).toEqual(["guidance: base"]);
    expect((await readContributionLedger(fixture.companionPath))?.unswept).toEqual([
      "@fixture/ba",
      "@fixture/qa",
    ]);
  });

  test("a later pass retries an unswept plugin once it loads", async () => {
    await leakWithoutLedger();
    await applySetupCompatibilities(fixture.companionPath, fixture.config, "sync", baseOnly());
    expect(await markerHitsInTree(fixture.companionPath, ["ba"])).not.toEqual([]);

    await installFixturePackage(fixture, "ba");
    await installFixturePackage(fixture, "qa");
    const outcome = await applySetupCompatibilities(
      fixture.companionPath,
      fixture.config,
      "sync",
      baseOnly(),
    );

    expect(outcome.warnings).toEqual([]);
    expect(await markerHitsInTree(fixture.companionPath, ["ba", "qa"])).toEqual([]);
    expect((await readContributionLedger(fixture.companionPath))?.unswept).toBeUndefined();
  });
});

describe("the audience-layer projection target", () => {
  function layerContext(audience: string | undefined, layerRoot?: string): SetupContext {
    return {
      companionPath: fixture.companionPath,
      config: fixture.config,
      mode: "sync",
      activeProviders: ["claude", "opencode"],
      target: "audience-layer",
      ...(audience ? { audience } : {}),
      ...(layerRoot ? { layerRoot } : {}),
    };
  }

  test("resolves its root under Mate's machine-local state, keyed by companion and audience", () => {
    const root = surfaceRoot(layerContext("ba"));
    expect(root).toBe(audienceLayerDir(fixture.companionPath, "ba"));
    expect(root.startsWith(path.join(mateHome(), "state", "audience-layers"))).toBe(true);
    expect(root.endsWith(`${path.sep}ba`)).toBe(true);
    expect(audienceLayerDir(fixture.companionPath, "qa")).not.toBe(root);
    expect(root.startsWith(fixture.companionPath)).toBe(false);
  });

  test("refuses a pass without an audience rather than fall back to another root", () => {
    expect(() => surfaceRoot(layerContext(undefined))).toThrow(/audience/);
  });

  test("a layer pass writes the active audience's contributions under the layer root only", async () => {
    const layerRoot = path.join(fixture.root, "layer");
    await reconcileAudienceLayer(layerContext("ba", layerRoot), fixture.registrations());

    expect(await markerHitsInTree(fixture.companionPath, ["base", "ba", "qa"])).toEqual([]);
    expect(await markerHitsInTree(fixture.repoPath, ["base", "ba", "qa"])).toEqual([]);
    expect(await markerHitsInTree(layerRoot, ["base", "qa"])).toEqual([]);
    const hits = await markerHitsInTree(layerRoot, ["ba"]);
    for (const file of [
      ".mcp.json",
      "CLAUDE.md",
      "AGENTS.md",
      ".opencode/opencode.json",
      ".claude/settings.local.json",
      ".claude/skills/ba-skill/SKILL.md",
      ".claude/agents/ba-agent.md",
      ".agents/skills/ba-skill/SKILL.md",
      ".opencode/agents/ba-agent.md",
    ]) {
      expect(hits).toContain(`${file}: ba`);
    }
  });

  test("an audience plugin's OpenCode plugin reference reaches no layer", async () => {
    const layerRoot = path.join(fixture.root, "layer");
    await reconcileAudienceLayer(
      layerContext("ba", layerRoot),
      fixture.registrations({ ba: { pluginReference: "ba-opencode-plugin@1.0.0" } }),
    );
    const files = await readTree(layerRoot);
    expect([...files.values()].some((text) => text.includes("ba-opencode-plugin"))).toBe(false);
  });
});

describe("rendering an audience layer", () => {
  function request(overrides: Partial<AudienceLayerRequest> = {}): AudienceLayerRequest {
    return {
      companionPath: fixture.companionPath,
      config: fixture.config,
      audience: "ba",
      activeProviders: ["claude", "opencode"],
      registrations: fixture.registrations(),
      ...overrides,
    };
  }

  test("renders the audience's contributions only, readable by the current user only", async () => {
    const layer = await renderAudienceLayer(request());

    expect(layer.rendered).toBe(true);
    expect(layer.root.startsWith(audienceLayerDir(fixture.companionPath, "ba"))).toBe(true);
    expect(currentAudienceLayer(fixture.companionPath, "ba")).toBe(layer.root);
    expect(await markerHitsInTree(layer.root, ["base", "qa"])).toEqual([]);
    expect(await markerHitsInTree(layer.root, ["ba"])).toContain(".mcp.json: ba");
    for (const dir of [audienceLayersRoot(), layer.root]) {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  test("an unchanged audience reuses its layer", async () => {
    const first = await renderAudienceLayer(request());
    const mcp = path.join(first.root, ".mcp.json");
    const before = (await fs.stat(mcp)).mtimeMs;

    const second = await renderAudienceLayer(request());

    expect(second).toEqual({ ...first, rendered: false });
    expect((await fs.stat(mcp)).mtimeMs).toBe(before);
  });

  test("a changed input renders a new layer beside the previous, complete one", async () => {
    const first = await renderAudienceLayer(request());
    const second = await renderAudienceLayer(request({ activeProviders: ["claude"] }));

    expect(second.rendered).toBe(true);
    expect(second.root).not.toBe(first.root);
    expect(currentAudienceLayer(fixture.companionPath, "ba")).toBe(second.root);
    expect(await markerHitsInTree(first.root, ["ba"])).toContain(".opencode/opencode.json: ba");
    expect(await markerHitsInTree(second.root, ["ba"])).not.toContain(
      ".opencode/opencode.json: ba",
    );
  });

  test("concurrent renders of one audience leave one complete layer and no staging", async () => {
    const layers = await Promise.all([
      renderAudienceLayer(request()),
      renderAudienceLayer(request()),
      renderAudienceLayer(request()),
    ]);

    expect(new Set(layers.map((layer) => layer.root)).size).toBe(1);
    const entries = await fs.readdir(audienceLayerDir(fixture.companionPath, "ba"));
    expect(entries.toSorted()).toEqual([path.basename(layers[0]!.root), "current"].toSorted());
    expect(await markerHitsInTree(layers[0]!.root, ["ba"])).toContain(
      ".claude/agents/ba-agent.md: ba",
    );
  });
});

describe("the OpenCode Runtime Surface's layer reader", () => {
  test("returns what a layer pass wrote: MCP servers, skills, agents and guidance", async () => {
    const layer = await renderAudienceLayer({
      companionPath: fixture.companionPath,
      config: fixture.config,
      audience: "ba",
      activeProviders: ["claude", "opencode"],
      registrations: fixture.registrations(),
    });

    const contents = await readOpenCodeAudienceLayer(layer.root);

    expect(contents.mcpServers).toEqual([
      {
        name: "ba-mcp",
        config: { type: "local", command: ["BAMARK7-server", "serve"], disabled: false },
      },
    ]);
    expect(contents.skills.map((skill) => [skill.id, skill.name, skill.description])).toEqual([
      ["ba-skill", "ba-skill", "ba skill"],
    ]);
    expect(contents.skills[0]?.content).toContain("BAMARK7 skill body.");
    expect(contents.skills[0]?.path).toBe(
      path.join(layer.root, ".agents", "skills", "ba-skill", "SKILL.md"),
    );
    expect(contents.agents).toEqual([
      { id: "ba-agent", description: "ba agent", mode: "all", system: "BAMARK7 agent prompt." },
    ]);
    expect(contents.guidance).toBe("BAMARK7 guidance for ba.");
    expect(markerHitsInValue("reader", contents, ["base", "qa"])).toEqual([]);
  });

  test("a missing or empty layer reads as nothing", async () => {
    expect(await readOpenCodeAudienceLayer(path.join(fixture.root, "absent"))).toEqual({
      mcpServers: [],
      skills: [],
      agents: [],
      guidance: "",
    });
  });
});

describe("isolation matrix", () => {
  /** A Claude and an OpenCode launch's arguments and environment, as the adapters build them. */
  async function launches(layer?: RenderedAudienceLayer) {
    const context = {
      repository: { id: "repo", path: fixture.repoPath },
      launchWorkingDirectory: fixture.repoPath,
      allowedAgents: ["claude", "opencode"],
      companionPath: fixture.companionPath,
      capabilities: [],
    };
    const prepared: PrepareResult = {
      ok: true,
      mode: "attended",
      runtime: "claude",
      runtimes: ["claude"],
      repositoryId: "repo",
      companionPath: fixture.companionPath,
      steps: [],
      warnings: [],
      wrapState: wrapStateOf(withDocument(EMPTY_MANIFEST, CLAUDE_SETTINGS_DOCUMENT, [])),
      ...(layer ? { audienceLayer: layer } : {}),
    };
    const claude = new ClaudeAdapter();
    const claudePlan = await claude.planLaunch(context, prepared);
    const opencode = new OpenCodeAdapter(() => "2.0.0");
    const opencodePlan = await opencode.planLaunch(context, prepared);
    const opencodeLaunch = await opencode.prepareLaunch(opencodePlan, []);
    const settings = claudePlan.delivery.settingsPath
      ? await fs.readFile(claudePlan.delivery.settingsPath, "utf8")
      : "";
    const layerReadByPlugin = layer
      ? await readOpenCodeAudienceLayer(
          JSON.parse(opencodeLaunch.env.MATE_GUIDANCE_JSON ?? "{}").audienceLayer,
        )
      : null;
    return {
      claudeArgs: claude.buildArgs(claudePlan, []),
      claudeSettings: settings,
      opencodePayload: opencodeLaunch.env.MATE_GUIDANCE_JSON,
      layerReadByPlugin,
    };
  }

  test("no ba contribution reaches base, qa or any persisted file", async () => {
    // An older Mate leaked ba and qa into the companion; no ledger yet.
    const leaked = fixture
      .registrations()
      .map((entry) => ("plugin" in entry && entry.audience ? { ...entry, audience: null } : entry));
    await applySetupCompatibilities(fixture.companionPath, fixture.config, "setup", leaked);
    await fs.rm(contributionLedgerPath(fixture.companionPath));

    // Setup and a managed launch's sync and wrap under MATE_AUDIENCE=ba: the sweep runs here.
    const wrap = await withEnv("MATE_AUDIENCE", "ba", async () => {
      await applySetupCompatibilities(
        fixture.companionPath,
        fixture.config,
        "setup",
        fixture.registrations(),
      );
      return renderWorkingRuntimeDocuments(
        fixture.companionPath,
        fixture.config,
        fixture.repoPath,
        fixture.registrations(),
      );
    });

    // Concurrent ba and qa managed launches.
    const [baLayer, qaLayer] = await Promise.all(
      (["ba", "qa"] as const).map((audience) =>
        renderAudienceLayer({
          companionPath: fixture.companionPath,
          config: fixture.config,
          audience,
          activeProviders: ["claude", "opencode"],
          registrations: fixture.registrations(),
        }),
      ),
    );
    const [ba, qa, base] = await Promise.all([launches(baLayer), launches(qaLayer), launches()]);

    // A bare session's prepare afterwards, with a stray MATE_AUDIENCE: base only.
    const bare = await withEnv("MATE_AUDIENCE", "ba", () =>
      renderWorkingRuntimeDocuments(
        fixture.companionPath,
        fixture.config,
        fixture.repoPath,
        fixture.registrations(),
      ),
    );

    expect(await markerHitsInTree(fixture.companionPath, ["ba", "qa"])).toEqual([]);
    expect(await markerHitsInTree(fixture.repoPath, ["ba", "qa"])).toEqual([]);
    expect(markerHitsInValue("wrap", wrap.documents, ["ba", "qa"])).toEqual([]);
    expect(markerHitsInValue("bare", bare.documents, ["ba", "qa"])).toEqual([]);
    expect(markerHitsInValue("base launch", base, ["ba", "qa"])).toEqual([]);
    expect(await markerHitsInTree(qaLayer!.root, ["ba", "base"])).toEqual([]);
    expect(markerHitsInValue("qa launch", qa, ["ba"])).toEqual([]);
    expect(await markerHitsInTree(baLayer!.root, ["qa", "base"])).toEqual([]);
    expect(markerHitsInValue("ba launch", ba, ["qa"])).toEqual([]);

    // The ba launch does receive ba, through its layer only.
    expect(ba.claudeArgs).toContain(baLayer!.root);
    expect(ba.claudeSettings).toContain("BAMARK7-hook.sh");
    expect(ba.layerReadByPlugin?.mcpServers.map((server) => server.name)).toEqual(["ba-mcp"]);
    expect(ba.layerReadByPlugin?.agents.map((agent) => agent.id)).toEqual(["ba-agent"]);
  });
});
