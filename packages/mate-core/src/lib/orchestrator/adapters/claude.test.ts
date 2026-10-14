import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  OPENCODE_CONFIG_DOCUMENT,
  withAudience,
  withDocument,
} from "../../../runtime/runtime-document-manifest";
import { wrapStateOf, type WrapState } from "../../../runtime/wrap-state";
import type { PrepareResult, PrepareStep } from "../session-prepare";
import { LaunchPreflightError } from "../types";
import type { AdapterContext } from "./base";
import { audienceLayerDir } from "../../../runtime/audience-layer";
import { ClaudeAdapter, launchSettingsPath } from "./claude";

const CARRIED = { hooks: [{ type: "command", command: "acme-wrapped" }] };
const claudeWrapState = wrapStateOf(
  withDocument(EMPTY_MANIFEST, CLAUDE_SETTINGS_DOCUMENT, [
    { at: ["hooks", "Stop"], kind: "list", values: [CARRIED] },
  ]),
);

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A companion that is a real directory holding `settings`. */
async function companionWith(settings: object) {
  const companionPath = await fs.mkdtemp(path.join(os.tmpdir(), "acme-launch-plan-"));
  tempRoots.push(companionPath);
  const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings), "utf8");
  return { companionPath, settingsPath };
}

function contextFor(companionPath: string, scope: "repo" | "companion" = "repo"): AdapterContext {
  return {
    ...(scope === "repo" ? { repository: { id: "repo", path: "/tmp/repo" } } : {}),
    launchWorkingDirectory: scope === "repo" ? "/tmp/repo" : companionPath,
    allowedAgents: ["claude"],
    companionPath,
    capabilities: [],
  };
}

function prepared(
  overrides: {
    wrapState?: WrapState;
    steps?: PrepareStep[];
    failure?: unknown;
    audienceLayer?: PrepareResult["audienceLayer"];
  } = {},
): PrepareResult {
  return {
    ok: overrides.steps === undefined,
    mode: "attended",
    runtime: "claude",
    runtimes: ["claude"],
    repositoryId: "repo",
    companionPath: "/tmp/companion",
    steps: overrides.steps ?? [],
    warnings: [],
    wrapState: overrides.wrapState ?? claudeWrapState,
    ...(overrides.failure === undefined ? {} : { failure: overrides.failure }),
    ...(overrides.audienceLayer ? { audienceLayer: overrides.audienceLayer } : {}),
  };
}

/** A rendered layer holding an MCP configuration and the audience's hooks and permission entries. */
async function layerFor(audience: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `acme-layer-${audience}-`));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".claude", "settings.local.json"),
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `${audience}-hook.sh` }] }] },
      permissions: { allow: [`Bash(${audience}:*)`] },
    }),
    "utf8",
  );
  await fs.writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
  return { audience, root, rendered: true };
}

function flagValues(args: string[], flag: string): string[] {
  return args.filter((_, index) => args[index - 1] === flag);
}

describe("the Claude delivery plan at launch", () => {
  test("a launch with a repository defers to its pass's wrap and writes the rest as settings", async () => {
    const companionOnly = { hooks: [{ type: "command", command: "acme-companion" }] };
    const { companionPath } = await companionWith({
      hooks: { Stop: [CARRIED, companionOnly] },
      autoMemoryEnabled: false,
    });

    const launch = await new ClaudeAdapter().planLaunch(contextFor(companionPath), prepared());

    const derived = launchSettingsPath(companionPath, "repo");
    expect(derived).toBe(path.join(companionPath, ".claude", "state", "launch-settings.repo.json"));
    expect(launch.delivery).toEqual({
      plan: expect.objectContaining({
        hooks: { owner: "wrap", launchSettingsExclude: [CARRIED] },
        mcp: "wrap",
        dirAccess: "wrap",
      }),
      settingsPath: derived,
    });
    expect(JSON.parse(await fs.readFile(derived, "utf8"))).toEqual({
      hooks: { Stop: [companionOnly] },
      autoMemoryEnabled: false,
    });
  });

  test("a launch whose prepare left no Claude wrap fails preflight naming mate wrap", async () => {
    const { companionPath } = await companionWith({});

    const failure = new ClaudeAdapter().planLaunch(
      contextFor(companionPath),
      prepared({
        wrapState: wrapStateOf(withDocument(EMPTY_MANIFEST, OPENCODE_CONFIG_DOCUMENT, [])),
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(LaunchPreflightError);
    await expect(failure).rejects.toThrow(/repo[\s\S]*mate wrap/);
  });

  test("a companion-scoped launch passes the companion's own settings", async () => {
    const { companionPath, settingsPath } = await companionWith({});

    const launch = await new ClaudeAdapter().planLaunch(
      contextFor(companionPath, "companion"),
      prepared(),
    );

    expect(launch.delivery).toEqual({
      plan: expect.objectContaining({
        hooks: { owner: "settings", launchSettingsExclude: [] },
        mcp: "mcp-config",
        dirAccess: "add-dir",
        reconcile: "none",
      }),
      settingsPath,
    });
  });
});

describe("a failed Claude prepare", () => {
  test("a failed wrap pass names the entry that failed", () => {
    const cause = new Error("EACCES");
    const failure = new ClaudeAdapter().launchFailure(
      prepared({
        steps: [
          {
            step: "working-target",
            outcome: "failed",
            detail: "failed to write .claude/settings.local.json for repo: EACCES",
          },
        ],
        failure: cause,
      }),
    );

    expect(failure).toBeInstanceOf(LaunchPreflightError);
    expect((failure as Error).message).toBe(
      "mate: reconciling the Claude wrap of repo failed: failed to write .claude/settings.local.json for repo: EACCES",
    );
    expect((failure as Error).cause).toBe(cause);
  });

  test("any other failed step raises its own error", () => {
    const own = new Error("sync failed");

    const failure = new ClaudeAdapter().launchFailure(
      prepared({ steps: [{ step: "git-sync", outcome: "failed", detail: "x" }], failure: own }),
    );

    expect(failure).toBe(own);
  });
});

describe("an audience launch", () => {
  const companionOnly = { hooks: [{ type: "command", command: "acme-companion" }] };

  test("attaches the layer by --add-dir and an additional --mcp-config", async () => {
    const { companionPath } = await companionWith({ hooks: { Stop: [companionOnly] } });
    const layer = await layerFor("ba");
    const adapter = new ClaudeAdapter();

    const launch = await adapter.planLaunch(
      contextFor(companionPath),
      prepared({ audienceLayer: layer }),
    );
    const args = adapter.buildArgs(launch, ["--print", "hi"]);

    expect(flagValues(args, "--add-dir")).toEqual([layer.root]);
    expect(flagValues(args, "--mcp-config")).toEqual([path.join(layer.root, ".mcp.json")]);
    expect(args.slice(-2)).toEqual(["--print", "hi"]);
    expect(adapter.extendEnvironment(launch).CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe(
      "1",
    );
  });

  test("merges the layer's hooks and permission entries into its one settings file", async () => {
    const { companionPath } = await companionWith({
      hooks: { Stop: [CARRIED, companionOnly] },
      permissions: { allow: ["Bash(mate:*)"] },
    });
    const adapter = new ClaudeAdapter();

    const launch = await adapter.planLaunch(
      contextFor(companionPath),
      prepared({ audienceLayer: await layerFor("ba") }),
    );
    const args = adapter.buildArgs(launch, []);

    expect(flagValues(args, "--settings")).toEqual([
      launchSettingsPath(companionPath, "repo", "ba"),
    ]);
    expect(JSON.parse(await fs.readFile(launch.delivery.settingsPath!, "utf8"))).toEqual({
      hooks: { Stop: [companionOnly, { hooks: [{ type: "command", command: "ba-hook.sh" }] }] },
      permissions: { allow: ["Bash(mate:*)", "Bash(ba:*)"] },
    });
  });

  test("concurrent ba and qa launches in one repository write different settings files", async () => {
    const { companionPath } = await companionWith({ hooks: { Stop: [companionOnly] } });
    const adapter = new ClaudeAdapter();

    const [ba, qa] = await Promise.all(
      ["ba", "qa"].map(async (audience) =>
        adapter.planLaunch(
          contextFor(companionPath),
          prepared({ audienceLayer: await layerFor(audience) }),
        ),
      ),
    );
    const baArgs = adapter.buildArgs(ba!, []);
    const qaArgs = adapter.buildArgs(qa!, []);

    expect(flagValues(baArgs, "--settings")).toHaveLength(1);
    expect(flagValues(qaArgs, "--settings")).toHaveLength(1);
    expect(ba!.delivery.settingsPath).not.toBe(qa!.delivery.settingsPath);
    const baText = await fs.readFile(ba!.delivery.settingsPath!, "utf8");
    const qaText = await fs.readFile(qa!.delivery.settingsPath!, "utf8");
    expect(baText).toContain("ba-hook.sh");
    expect(baText).not.toContain("qa-");
    expect(qaText).toContain("qa-hook.sh");
    expect(qaText).not.toContain("ba-");
    expect(baText).toContain("acme-companion");
    expect(qaText).toContain("acme-companion");
  });

  test("a companion-scoped launch with an audience derives a merged file instead of the companion's", async () => {
    const { companionPath, settingsPath } = await companionWith({
      hooks: { Stop: [companionOnly] },
    });
    const layer = await layerFor("ba");
    const adapter = new ClaudeAdapter();

    const launch = await adapter.planLaunch(
      contextFor(companionPath, "companion"),
      prepared({ audienceLayer: layer }),
    );
    const args = adapter.buildArgs(launch, []);

    const derived = launchSettingsPath(companionPath, null, "ba");
    expect(derived).not.toBe(settingsPath);
    expect(flagValues(args, "--settings")).toEqual([derived]);
    expect(flagValues(args, "--add-dir")).toEqual([companionPath, layer.root]);
    expect(await fs.readFile(derived, "utf8")).toContain("ba-hook.sh");
  });

  test("a launch without an audience passes exactly what it passed before", async () => {
    const { companionPath } = await companionWith({ hooks: { Stop: [companionOnly] } });
    const adapter = new ClaudeAdapter();

    const launch = await adapter.planLaunch(contextFor(companionPath), prepared());
    const args = adapter.buildArgs(launch, []);

    expect(launch.delivery.layer).toBeUndefined();
    expect(flagValues(args, "--add-dir")).toEqual([]);
    expect(flagValues(args, "--mcp-config")).toEqual([]);
    expect(flagValues(args, "--settings")).toEqual([
      path.join(companionPath, ".claude", "state", "launch-settings.repo.json"),
    ]);
  });
});

describe("a launch in a checkout wrapped for an audience", () => {
  test("appends the wrapped audience's guidance and adds no layer flags", async () => {
    const { companionPath } = await companionWith({});
    const dir = audienceLayerDir(companionPath, "ba");
    await fs.mkdir(path.join(dir, "f1"), { recursive: true });
    await fs.writeFile(path.join(dir, "f1", "CLAUDE.md"), "Guidance for ba.\n", "utf8");
    await fs.rm(path.join(dir, "current"), { force: true });
    await fs.symlink("f1", path.join(dir, "current"));
    tempRoots.push(dir);
    const wrapState = wrapStateOf(
      withAudience(
        withDocument(EMPTY_MANIFEST, CLAUDE_SETTINGS_DOCUMENT, [
          { at: ["hooks", "Stop"], kind: "list", values: [CARRIED] },
        ]),
        "ba",
      ),
    );
    const adapter = new ClaudeAdapter();

    const launch = await adapter.planLaunch(contextFor(companionPath), prepared({ wrapState }));
    const args = adapter.buildArgs(launch, []);

    expect(flagValues(args, "--add-dir")).toEqual([]);
    expect(flagValues(args, "--mcp-config")).toEqual([]);
    const prompt = flagValues(args, "--append-system-prompt")[0]!;
    expect(prompt).toContain("<companion-policy ");
    expect(prompt.indexOf("Guidance for ba.")).toBeGreaterThan(
      prompt.indexOf("<companion-policy "),
    );
  });
});
