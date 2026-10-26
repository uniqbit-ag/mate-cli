import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { launchPluginFolders } from "../../../runtime/claude-delivery-plan";
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

const COMPANION_RULE = "Code comments: JSDoc format only, never `//`.";
const AGENTS_MD = `<!-- MATE:COMPANION:START -->\n\n- ${COMPANION_RULE}\n\n<!-- MATE:COMPANION:END -->\n`;

async function companionWith(settings: object, options: { agentsMd?: boolean } = {}) {
  const companionPath = await fs.mkdtemp(path.join(os.tmpdir(), "acme-launch-plan-"));
  tempRoots.push(companionPath);
  const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings), "utf8");
  if (options.agentsMd !== false) {
    await fs.writeFile(path.join(companionPath, "AGENTS.md"), AGENTS_MD, "utf8");
  }
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

  test("a launch carries the managed attribution unless the repository sets its own", async () => {
    const { companionPath } = await companionWith({});
    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "acme-launch-repo-"));
    tempRoots.push(repo);
    const context = { ...contextFor(companionPath), repository: { id: "repo", path: repo } };
    const derived = async () =>
      JSON.parse(await fs.readFile(launchSettingsPath(companionPath, "repo"), "utf8"));

    await new ClaudeAdapter().planLaunch(context, prepared());
    expect((await derived()).attribution).toEqual({ commit: "", pr: "", sessionUrl: false });

    await fs.mkdir(path.join(repo, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify({ attribution: { pr: "Built with AI" } }),
    );
    await new ClaudeAdapter().planLaunch(context, prepared());
    expect("attribution" in (await derived())).toBe(false);
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
  test("passes the plan's folder list as --plugin-dir flags, in order, before the user's args", async () => {
    const { companionPath } = await companionWith({});
    const adapter = new ClaudeAdapter();
    const launch = await adapter.planLaunch(
      contextFor(companionPath),
      prepared({ claudePluginDirectories: ["/acme/plugins/zeta", "/acme/plugins/alpha"] }),
    );

    const args = adapter.buildArgs(launch, ["--print"]);

    expect(pluginDirs(args)).toEqual(
      launchPluginFolders(
        launch.delivery.plan,
        ["/acme/plugins/zeta", "/acme/plugins/alpha"],
        getClaudePluginRoot(),
      ),
    );
    expect(pluginDirs(args)).toEqual([
      getClaudePluginRoot(),
      "/acme/plugins/zeta",
      "/acme/plugins/alpha",
    ]);
    expect(args.at(-1)).toBe("--print");
  });
});

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Claude's options that read values up to the next argument starting with `-`. */
const VARIADIC = new Set(["--add-dir", "--allowedTools", "--mcp-config", "--tools"]);
const SINGLE = new Set([
  "--append-system-prompt",
  "--system-prompt-snapshot",
  "--setting-sources",
  "--settings",
  "--plugin-dir",
]);

function positionalPrompt(args: string[]): string[] {
  const positionals: string[] = [];
  let variadic = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return [...positionals, ...args.slice(index + 1)];
    if (arg.startsWith("-")) {
      variadic = VARIADIC.has(arg);
      if (SINGLE.has(arg)) index += 1;
    } else if (!variadic) {
      positionals.push(arg);
    }
  }
  return positionals;
}

describe("Companion Instructions at launch", () => {
  async function repoLaunch() {
    const { companionPath } = await companionWith({});
    const adapter = new ClaudeAdapter();
    const launch = await adapter.planLaunch(contextFor(companionPath), prepared());
    return { adapter, launch, companionPath };
  }

  test("a fresh launch with a repository appends them once, after the policy, and keeps the default snapshot", async () => {
    const { adapter, launch, companionPath } = await repoLaunch();

    const args = adapter.buildArgs(launch, ["--print"]);

    const prompt = flagValue(args, "--append-system-prompt")!;
    expect(occurrences(prompt, "<companion-instructions")).toBe(1);
    expect(prompt.indexOf("<companion-instructions")).toBeGreaterThan(
      prompt.indexOf("<companion-policy"),
    );
    expect(prompt).toContain(COMPANION_RULE);
    expect(prompt).toContain(`source="${path.join(companionPath, "AGENTS.md")}"`);
    expect(args).not.toContain("--system-prompt-snapshot");
    expect(args.at(-1)).toBe("--print");
  });

  test("a companion-scoped launch appends none and leaves snapshots alone, even on a resume", async () => {
    const { companionPath } = await companionWith({});
    const adapter = new ClaudeAdapter();
    const launch = await adapter.planLaunch(contextFor(companionPath, "companion"), prepared());

    const args = adapter.buildArgs(launch, ["--resume"]);

    expect(flagValue(args, "--append-system-prompt")).not.toContain("<companion-instructions");
    expect(args).not.toContain("--system-prompt-snapshot");
  });

  test.each([
    [["--resume"]],
    [["--resume", "abc"]],
    [["--resume=abc"]],
    [["-r"]],
    [["-rabc"]],
    [["--continue"]],
    [["-c"]],
    [["-pc"]],
    [["--from-pr", "12"]],
    [["--teleport"]],
  ])(
    "a resumed or continued conversation %p gets snapshots off once, right after the prompt",
    async (passthrough) => {
      const { adapter, launch } = await repoLaunch();

      const args = adapter.buildArgs(launch, passthrough);

      const prompt = args.indexOf("--append-system-prompt");
      expect(args.slice(prompt + 2, prompt + 4)).toEqual(["--system-prompt-snapshot", "off"]);
      expect(occurrences(args.join("\0"), "--system-prompt-snapshot")).toBe(1);
      expect(args.slice(-passthrough.length)).toEqual(passthrough);
    },
  );

  test.each([
    [["--resume", "--system-prompt-snapshot", "on"]],
    [["--resume", "--system-prompt-snapshot=on"]],
  ])("the user's own snapshot setting %p wins on a resume", async (passthrough) => {
    const { adapter, launch } = await repoLaunch();

    const args = adapter.buildArgs(launch, passthrough);

    expect(args.filter((arg) => arg.startsWith("--system-prompt-snapshot"))).toHaveLength(1);
    expect(args.slice(-passthrough.length)).toEqual(passthrough);
    expect(args).not.toContain("off");
  });

  test("a snapshot flag after `--` is prompt text, so a resume still gets snapshots off", async () => {
    const { adapter, launch } = await repoLaunch();
    const passthrough = ["--resume", "--", "--system-prompt-snapshot=on"];

    const args = adapter.buildArgs(launch, passthrough);

    expect(flagValue(args, "--system-prompt-snapshot")).toBe("off");
    expect(args.slice(-passthrough.length)).toEqual(passthrough);
  });

  test.each([
    [["-p"]],
    [["-d", "api"]],
    [["--model", "sonnet"]],
    [["-dc"]],
    [["-pdc"]],
    [["-wc"]],
    [["-nr"]],
  ])(
    "a fresh session with the flags %p gets no snapshot flag: a value-taking short flag ends the cluster",
    async (passthrough) => {
      const { adapter, launch } = await repoLaunch();

      const args = adapter.buildArgs(launch, passthrough);

      expect(args).not.toContain("--system-prompt-snapshot");
      expect(args.slice(-passthrough.length)).toEqual(passthrough);
    },
  );

  test.each([[["--", "--system-prompt-snapshot=on"]], [["--print", "--", "--resume"]]])(
    "a fresh session whose prompt text %p mentions a flag gets no snapshot flag",
    async (passthrough) => {
      const { adapter, launch } = await repoLaunch();

      const args = adapter.buildArgs(launch, passthrough);

      expect(args).not.toContain("--system-prompt-snapshot");
      expect(args).not.toContain("off");
      expect(args.slice(-passthrough.length)).toEqual(passthrough);
    },
  );

  test.each([
    [["--append-system-prompt", "ACME-OWN-PROMPT", "--print"]],
    [["--append-system-prompt=ACME-OWN-PROMPT", "--print"]],
  ])(
    "the operator's own appended prompt %p follows the instructions in Mate's single flag",
    async (passthrough) => {
      const { adapter, launch } = await repoLaunch();

      const args = adapter.buildArgs(launch, passthrough);

      expect(args.filter((arg) => arg.startsWith("--append-system-prompt"))).toHaveLength(1);
      const prompt = flagValue(args, "--append-system-prompt")!;
      expect(prompt.endsWith("\n\nACME-OWN-PROMPT")).toBe(true);
      expect(prompt.indexOf("ACME-OWN-PROMPT")).toBeGreaterThan(
        prompt.indexOf("<companion-instructions"),
      );
      expect(args.at(-1)).toBe("--print");
    },
  );

  test.each([
    [["--print", "--add-dir", "/tmp/acme-extra", "--append-system-prompt", "ACME", "say hi"]],
    [["--allowedTools", "Read", "--append-system-prompt=ACME", "say hi"]],
    [
      [
        "--mcp-config",
        "acme.json",
        "--append-system-prompt",
        "A",
        "--append-system-prompt",
        "B",
        "say hi",
      ],
    ],
    [["--resume", "--tools", "Read", "--append-system-prompt", "ACME", "say hi"]],
  ])(
    "lifting the operator's appended prompt from %p leaves the initial prompt a prompt",
    async (passthrough) => {
      const { adapter, launch } = await repoLaunch();

      const args = adapter.buildArgs(launch, passthrough);

      expect(positionalPrompt(passthrough)).toEqual(["say hi"]);
      expect(positionalPrompt(args)).toEqual(["say hi"]);
      expect(args.filter((arg) => arg.startsWith("--append-system-prompt"))).toHaveLength(1);
      expect(flagValue(args, "--append-system-prompt")).toMatch(/\n\n(ACME|A\n\nB)$/);
    },
  );

  test.each([
    [["--", "--append-system-prompt", "ACME-OWN-PROMPT"]],
    [["--print", "--append-system-prompt"]],
  ])(
    "an appended prompt that is prompt text or lacks its value, %p, stays as passed",
    async (passthrough) => {
      const { adapter, launch } = await repoLaunch();

      const args = adapter.buildArgs(launch, passthrough);

      expect(flagValue(args, "--append-system-prompt")).not.toContain("ACME-OWN-PROMPT");
      expect(args.slice(-passthrough.length)).toEqual(passthrough);
    },
  );

  test("a launch with a repository fails before Claude starts when AGENTS.md is missing", async () => {
    const { companionPath } = await companionWith({}, { agentsMd: false });

    const failure = new ClaudeAdapter().planLaunch(contextFor(companionPath), prepared());

    await expect(failure).rejects.toBeInstanceOf(LaunchPreflightError);
    await expect(failure).rejects.toThrow(path.join(companionPath, "AGENTS.md"));
  });

  test("a companion-scoped launch does not need AGENTS.md", async () => {
    const { companionPath } = await companionWith({}, { agentsMd: false });

    const launch = new ClaudeAdapter().planLaunch(
      contextFor(companionPath, "companion"),
      prepared(),
    );

    await expect(launch).resolves.toBeDefined();
  });

  test("no launch sets the additional-directories memory variable", async () => {
    const { companionPath } = await companionWith({});
    const adapter = new ClaudeAdapter();
    for (const scope of ["repo", "companion"] as const) {
      const launch = await adapter.planLaunch(contextFor(companionPath, scope), prepared());
      expect(adapter.extendEnvironment(launch)).toEqual({});
    }
  });
});
