import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  OPENCODE_CONFIG_DOCUMENT,
  withDocument,
} from "../../../runtime/runtime-document-manifest";
import { wrapStateOf, type WrapState } from "../../../runtime/wrap-state";
import {
  renderSecretDenyEntries,
  syncCompanionClaudeSettings,
} from "../../../tools/setup/providers/claude";
import { getClaudePluginRoot } from "../../package-paths";
import type { PrepareResult, PrepareStep } from "../session-prepare";
import { LaunchPreflightError } from "../types";
import type { AdapterContext } from "./base";
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
    claudePluginDirectories?: string[];
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
    ...(overrides.claudePluginDirectories
      ? { claudePluginDirectories: overrides.claudePluginDirectories }
      : {}),
  };
}

/** The values that follow each `--plugin-dir`, in order. */
function pluginDirs(args: string[]): string[] {
  return args.filter((_, index) => args[index - 1] === "--plugin-dir");
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

  test("a launch with a repository keeps the disabled Claude features", async () => {
    const { companionPath } = await companionWith({});
    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    await new ClaudeAdapter().planLaunch(contextFor(companionPath), prepared());

    const derived = JSON.parse(
      await fs.readFile(launchSettingsPath(companionPath, "repo"), "utf8"),
    );
    expect(derived.permissions.deny).toEqual([
      "EnterPlanMode",
      "DesignSync",
      ...renderSecretDenyEntries(),
    ]);
    expect(derived.enableArtifact).toBe(false);
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

describe("Capability plugin folders at launch", () => {
  async function launchArgs(scope: "repo" | "companion", claudePluginDirectories?: string[]) {
    const { companionPath } = await companionWith({});
    const adapter = new ClaudeAdapter();
    const launch = await adapter.planLaunch(
      contextFor(companionPath, scope),
      prepared(claudePluginDirectories ? { claudePluginDirectories } : {}),
    );
    return adapter.buildArgs(launch, ["--print"]);
  }

  test("passes each gathered folder after the bundled plugin, in gathered order", async () => {
    const args = await launchArgs("repo", ["/acme/plugins/zeta", "/acme/plugins/alpha"]);

    expect(pluginDirs(args)).toEqual([
      getClaudePluginRoot(),
      "/acme/plugins/zeta",
      "/acme/plugins/alpha",
    ]);
    expect(args.at(-1)).toBe("--print");
  });

  test("passes only the bundled plugin when the prepare gathered no folder", async () => {
    expect(pluginDirs(await launchArgs("repo"))).toEqual([getClaudePluginRoot()]);
    expect(pluginDirs(await launchArgs("repo", []))).toEqual([getClaudePluginRoot()]);
  });

  test("a companion-scoped launch passes its gathered folders too", async () => {
    const args = await launchArgs("companion", ["/acme/plugins/zeta"]);

    expect(pluginDirs(args)).toEqual([getClaudePluginRoot(), "/acme/plugins/zeta"]);
  });

  test("a path with a space and a drive letter passes through unchanged", async () => {
    const windowsPath = "C:\\Users\\Acme Corp\\plugins\\acme";

    const args = await launchArgs("repo", [windowsPath]);

    expect(pluginDirs(args)).toEqual([getClaudePluginRoot(), windowsPath]);
  });
});
