import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { LaunchPreflightError } from "../types";
import { buildProjection } from "../projection-record";
import { project } from "../working-repo-projection";
import {
  PROJECTION_ENV_NAMES,
  PROJECTION_FIELDS,
  resolveProjection,
} from "../../../runtime/projection";
import { readCompanionRuntimeContext } from "../../../runtime/env";
import { repoLocalRegistryPath } from "../../../runtime/repo-local";
import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  withDocument,
} from "../../../runtime/runtime-document-manifest";
import { wrapStateOf } from "../../../runtime/wrap-state";
import { getContextModePackageRoot } from "../../context-mode-package";
import {
  getClaudePluginRoot,
  getReactDoctorBinPath,
  getWrapperBinPath,
  validateClaudePluginAssets,
} from "../../package-paths";
import {
  getActiveDistribution,
  resetActiveDistribution,
  setActiveDistribution,
} from "../../../distribution";
import {
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
} from "../../../tools/setup/providers/claude";
import { ClaudeAdapter, launchSettingsPath } from "./claude";
import { OpenCodeAdapter } from "./opencode";
import type { AdapterContext } from "./base";
import { withEnv } from "../../../../../../test/fixtures";

const tempRoots: string[] = [];
const OPENCODE_V2 = () => "2.0.20";

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function withPath<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = previous;
  }
}

const CLAUDE_WRAP = wrapStateOf(withDocument(EMPTY_MANIFEST, CLAUDE_SETTINGS_DOCUMENT, []));

/** As a launch hands the context over: planned by the adapter after a prepare that wrapped for Claude. */
function planClaude(context: AdapterContext, claudePluginDirectories?: string[]) {
  return new ClaudeAdapter().planLaunch(context, {
    ok: true,
    mode: "attended",
    runtime: "claude",
    runtimes: ["claude"],
    repositoryId: context.repository?.id,
    companionPath: context.companionPath,
    steps: [],
    warnings: [],
    wrapState: CLAUDE_WRAP,
    ...(claudePluginDirectories ? { claudePluginDirectories } : {}),
  });
}

async function prepareClaudeLaunch(context: AdapterContext, args: string[]) {
  return new ClaudeAdapter().prepareLaunch(await planClaude(context), args);
}

async function claudeArgs(
  context: AdapterContext,
  args: string[],
  claudePluginDirectories?: string[],
) {
  return new ClaudeAdapter().buildArgs(await planClaude(context, claudePluginDirectories), args);
}

/** A companion that holds the Claude settings and, when asked, the MCP config. */
async function claudeCompanion(prefix: string, options: { mcpConfig?: boolean } = {}) {
  const companionPath = await makeTempDir(prefix);
  const settingsPath = getCompanionClaudeSettingsPath(companionPath);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, "{}\n", "utf8");
  const mcpConfigPath = getCompanionClaudeMcpConfigPath(companionPath);
  if (options.mcpConfig) await fs.writeFile(mcpConfigPath, "{}\n", "utf8");
  return { companionPath, settingsPath, mcpConfigPath };
}

function makeContext(capabilities: AdapterContext["capabilities"] = []): AdapterContext {
  return {
    repository: {
      id: "app",
      path: "/tmp/app",
    },
    launchWorkingDirectory: "/tmp/app",
    allowedAgents: ["claude", "opencode"],
    companionPath: "/tmp/companion",
    capabilities,
  };
}

/** A launch materializes the record with the live install path, not the runtime directory. */
function projectionOf(context: AdapterContext) {
  return buildProjection(context.companionPath, context.repository, getWrapperBinPath());
}

/** A Working Repository the session scope has actually written a projection into. */
async function wrappedRepository(prefix: string) {
  const repoRoot = await makeTempDir(prefix);
  const repository = { id: "acme", path: repoRoot };
  const companionPath = path.join(repoRoot, "companion");
  await fs.mkdir(path.join(repoRoot, ".git", "info"), { recursive: true });
  await fs.mkdir(companionPath, { recursive: true });
  await fs.mkdir(path.dirname(repoLocalRegistryPath(repoRoot)), { recursive: true });
  await fs.writeFile(repoLocalRegistryPath(repoRoot), "companions: []\n", "utf8");
  await project("session", { repoPath: repoRoot, companionPath, repository });
  return { repoRoot, repository, companionPath };
}

/** The companion config carries no Mate plugin reference; the launch overlay supplies the plugin root. */
async function writeOpenCodeRuntime(companionPath: string, plugins: string[] = []): Promise<void> {
  await fs.mkdir(path.join(companionPath, ".opencode"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".opencode", "opencode.json"),
    JSON.stringify(plugins.length > 0 ? { plugins } : {}, null, 2) + "\n",
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("LaunchAdapter.prepareLaunch", () => {
  test("builds the Claude invocation without rewriting the model base URL", async () => {
    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      prepareClaudeLaunch(makeContext(), ["--print", "hello"]),
    );

    expect(launch.command).toBe("claude");
    expect(launch.args[0]).toBe("--append-system-prompt");
    expect(launch.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("an unrecognized capability leaves the OpenCode invocation and PATH untouched", async () => {
    const binDir = await makeTempDir("mate-launch-bin-");

    await withPath(binDir, async () => {
      const launch = await new OpenCodeAdapter(OPENCODE_V2).prepareLaunch(
        makeContext([{ name: "retired-capability" }]),
        ["--mode", "chat"],
      );

      expect(launch.command).toBe("opencode");
      expect(launch.args).toContain("--mode");
      expect(launch.args).toContain("chat");
      expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}${binDir}`);
    });
  });

  test("runs OpenCode on a private server so the companion config reaches it", () => {
    const adapter = new OpenCodeAdapter(OPENCODE_V2);
    const context = makeContext();

    expect(adapter.buildArgs(context, [])).toEqual(["/tmp/app", "--standalone"]);
    expect(adapter.buildArgs(context, ["--mode", "chat"])).toEqual([
      "/tmp/app",
      "--standalone",
      "--mode",
      "chat",
    ]);
    expect(adapter.buildArgs(context, ["run", "hi"])).toEqual(["run", "--standalone", "hi"]);
    expect(adapter.buildArgs(context, ["--standalone"])).toEqual(["/tmp/app", "--standalone"]);
    expect(adapter.buildArgs(context, ["--server", "http://acme"])).toEqual([
      "/tmp/app",
      "--server",
      "http://acme",
    ]);
    expect(adapter.buildArgs(context, ["mcp", "list"])).toEqual(["mcp", "list"]);
  });

  test("validates the required OpenCode companion plugin before launch", async () => {
    const companionPath = await makeTempDir("mate-opencode-companion-");
    await writeOpenCodeRuntime(companionPath);

    await expect(
      new OpenCodeAdapter(OPENCODE_V2).validateLaunch({ ...makeContext(), companionPath }),
    ).resolves.toBeUndefined();
  });

  test("refuses an OpenCode launch below 2.x or without a runnable binary", async () => {
    const companionPath = await makeTempDir("mate-opencode-version-");
    await writeOpenCodeRuntime(companionPath);
    const context = { ...makeContext(), companionPath };

    await expect(new OpenCodeAdapter(() => "1.18.29").validateLaunch(context)).rejects.toThrow(
      /OpenCode 1\.18\.29 is not supported[\s\S]*requires OpenCode 2\.x/,
    );
    await expect(new OpenCodeAdapter(() => undefined).validateLaunch(context)).rejects.toThrow(
      LaunchPreflightError,
    );
    await expect(
      new OpenCodeAdapter(() => "opencode v2.0.23").validateLaunch(context),
    ).resolves.toBeUndefined();
  });

  test("fails OpenCode launch validation when the companion plugin is missing", async () => {
    const companionPath = await makeTempDir("mate-opencode-missing-");

    await expect(
      new OpenCodeAdapter(OPENCODE_V2).validateLaunch({ ...makeContext(), companionPath }),
    ).rejects.toThrow(LaunchPreflightError);
    await expect(
      new OpenCodeAdapter(OPENCODE_V2).validateLaunch({ ...makeContext(), companionPath }),
    ).rejects.toThrow(/OpenCode companion runtime is incomplete/);
  });

  test("passes preflight without a Mate plugin reference in the companion config", async () => {
    const companionPath = await makeTempDir("mate-opencode-no-plugin-ref-");
    await writeOpenCodeRuntime(companionPath, ["opencode-acme-plugin"]);

    await expect(
      new OpenCodeAdapter(OPENCODE_V2).validateLaunch({ ...makeContext(), companionPath }),
    ).resolves.toBeUndefined();
  });

  test("fails preflight on an unparseable companion config with setup repair guidance", async () => {
    const companionPath = await makeTempDir("mate-opencode-unreadable-");
    await writeOpenCodeRuntime(companionPath);
    await fs.writeFile(path.join(companionPath, ".opencode", "opencode.json"), "{ not json\n");

    const launch = new OpenCodeAdapter(OPENCODE_V2).validateLaunch({
      ...makeContext(),
      companionPath,
    });
    await expect(launch).rejects.toThrow(/Unreadable OpenCode configuration/);
    await expect(launch).rejects.toThrow(/mate companion setup/);
  });

  test("fails preflight naming the missing bundled plugin entry and asking for a reinstall", async () => {
    const companionPath = await makeTempDir("mate-opencode-broken-plugin-");
    await writeOpenCodeRuntime(companionPath);
    const assetRoot = await makeTempDir("acme-assets-");
    await fs.mkdir(path.join(assetRoot, "opencode-plugin"));
    await fs.writeFile(path.join(assetRoot, "opencode-plugin", "server.ts"), "", "utf8");
    const { config, registry } = getActiveDistribution();
    setActiveDistribution({ config: { ...config, assetRoots: [assetRoot] }, registry });

    try {
      const launch = new OpenCodeAdapter(OPENCODE_V2).validateLaunch({
        ...makeContext(),
        companionPath,
      });
      await expect(launch).rejects.toThrow(LaunchPreflightError);
      await expect(launch).rejects.toThrow(/opencode-plugin[\s\S]*tui\.tsx[\s\S]*[Rr]einstall/);
    } finally {
      resetActiveDistribution();
    }
  });

  test("leaves context-mode package validation to the capability plugin", async () => {
    const companionPath = await makeTempDir("mate-opencode-context-mode-");
    await writeOpenCodeRuntime(companionPath);
    const context = { ...makeContext([{ name: "context-mode" }]), companionPath };

    await expect(new OpenCodeAdapter(OPENCODE_V2).validateLaunch(context)).resolves.toBeUndefined();
    await fs.writeFile(
      path.join(companionPath, ".opencode", "opencode.json"),
      JSON.stringify({ plugins: ["context-mode@0.0.1"] }),
    );
    await expect(new OpenCodeAdapter(OPENCODE_V2).validateLaunch(context)).resolves.toBeUndefined();
  });

  test("injects the companion guidance payload into the OpenCode launch environment", async () => {
    const adapter = new OpenCodeAdapter(OPENCODE_V2);

    const baseEnv = adapter.extendEnvironment(makeContext());
    const baseGuidance = JSON.parse(baseEnv.MATE_GUIDANCE_JSON ?? "{}");
    expect(baseGuidance.version).toBe(1);
    expect(baseGuidance.errors).toEqual([]);
    expect(baseGuidance.companionGuidance).toContain("<companion-policy ");
    expect(baseGuidance.companionGuidance).toContain("$MATE_ARTIFACT_PATH");
    expect(baseGuidance.companionGuidance).toContain("$MATE_WRAPPER_BIN_PATH");
    expect(baseGuidance.codebaseExplorationGuidance).toBe("");

    const tokensaveEnv = adapter.extendEnvironment(makeContext([{ name: "tokensave" }]));
    const tokensaveGuidance = JSON.parse(tokensaveEnv.MATE_GUIDANCE_JSON ?? "{}");
    expect(tokensaveGuidance.codebaseExplorationGuidance).toContain("<codebase-exploration-rules ");
    expect(tokensaveGuidance.codebaseExplorationGuidance).toContain("tokensave_context");

    const graphifyEnv = adapter.extendEnvironment(makeContext([{ name: "graphify" }]));
    const graphifyGuidance = JSON.parse(graphifyEnv.MATE_GUIDANCE_JSON ?? "{}");
    expect(graphifyGuidance.codebaseExplorationGuidance).toContain("<codebase-exploration-rules ");
    expect(graphifyGuidance.codebaseExplorationGuidance).toContain("graphify");
  });

  test("materializes a companion-scoped environment without repository values", async () => {
    const previousRepoPath = process.env.MATE_REPO_PATH;
    const previousRepoId = process.env.MATE_REPO_ID;
    process.env.MATE_REPO_PATH = "/inherited/repository";
    process.env.MATE_REPO_ID = "inherited";

    try {
      const context = {
        ...makeContext([{ name: "graphify" }, { name: "openspec" }]),
        repository: undefined,
        launchWorkingDirectory: "/tmp/companion",
      };
      const launch = await new OpenCodeAdapter(OPENCODE_V2).prepareLaunch(context, []);

      expect(launch.env.MATE_ARTIFACT_PATH).toBe("/tmp/companion");
      expect(launch.env.MATE_VERSION).toEqual(expect.any(String));
      expect(launch.env.MATE_WRAPPER_BIN_PATH).toContain("wrappers/bin");
      expect(launch.env.MATE_POLICY_JSON).toBe(
        JSON.stringify({ allowedAgents: ["claude", "opencode"] }),
      );
      expect(launch.env.MATE_GRAPHIFY_ENABLED).toBe("1");
      expect(launch.env.MATE_OPENSPEC_ENABLED).toBe("1");
      expect(launch.env.GRAPHIFY_OUT).toBe(
        path.join("/tmp/companion", ".graphify", "__companion__", "graphify-out"),
      );
      expect(launch.env.MATE_REPO_PATH).toBeUndefined();
      expect(launch.env.MATE_REPO_ID).toBeUndefined();
    } finally {
      if (previousRepoPath === undefined) delete process.env.MATE_REPO_PATH;
      else process.env.MATE_REPO_PATH = previousRepoPath;
      if (previousRepoId === undefined) delete process.env.MATE_REPO_ID;
      else process.env.MATE_REPO_ID = previousRepoId;
    }
  });

  test("passes the Studio report endpoint and credential through a companion-scoped launch", async () => {
    const previous = {
      url: process.env.MATE_STUDIO_REPORT_URL,
      token: process.env.MATE_STUDIO_REPORT_TOKEN,
    };
    process.env.MATE_STUDIO_REPORT_URL = "http://127.0.0.1:4321";
    process.env.MATE_STUDIO_REPORT_TOKEN = "session-credential";

    try {
      const scoped = {
        ...makeContext([{ name: "openspec" }]),
        repository: undefined,
        launchWorkingDirectory: "/tmp/companion",
      };
      for (const context of [scoped, makeContext([{ name: "openspec" }])]) {
        const launch = await new OpenCodeAdapter(OPENCODE_V2).prepareLaunch(context, []);
        expect(launch.env.MATE_STUDIO_REPORT_URL).toBe("http://127.0.0.1:4321");
        expect(launch.env.MATE_STUDIO_REPORT_TOKEN).toBe("session-credential");
      }
    } finally {
      for (const [key, value] of [
        ["MATE_STUDIO_REPORT_URL", previous.url],
        ["MATE_STUDIO_REPORT_TOKEN", previous.token],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("propagates real capabilities into companionGuidance, matching the Claude provider", async () => {
    const adapter = new OpenCodeAdapter(OPENCODE_V2);

    // Regression test: buildOpenCodeGuidance previously hardcoded an empty
    // capabilities array when calling buildCompanionGuidance, so
    // capability-gated rules (e.g. openspec-publish) never rendered for
    // OpenCode regardless of what was actually enabled.
    const openspecEnv = adapter.extendEnvironment(makeContext([{ name: "openspec" }]));
    const openspecGuidance = JSON.parse(openspecEnv.MATE_GUIDANCE_JSON ?? "{}");
    expect(openspecGuidance.companionGuidance).toContain("openspec-publish");

    const withoutOpenspecEnv = adapter.extendEnvironment(makeContext([{ name: "tokensave" }]));
    const withoutOpenspecGuidance = JSON.parse(withoutOpenspecEnv.MATE_GUIDANCE_JSON ?? "{}");
    expect(withoutOpenspecGuidance.companionGuidance).not.toContain("openspec-publish");

    // codebase-exploration-rules must appear exactly once (as the separate
    // field), never embedded a second time inside companionGuidance.
    const allCapsEnv = adapter.extendEnvironment(
      makeContext([{ name: "openspec" }, { name: "tokensave" }, { name: "react-doctor" }]),
    );
    const allCapsGuidance = JSON.parse(allCapsEnv.MATE_GUIDANCE_JSON ?? "{}");
    expect(allCapsGuidance.companionGuidance).not.toContain("<codebase-exploration-rules");
    expect(allCapsGuidance.codebaseExplorationGuidance).toContain("<codebase-exploration-rules ");
  });
});

describe("graphify GRAPHIFY_OUT env injection", () => {
  test("injects companion GRAPHIFY_OUT when graphify capability is enabled", async () => {
    const launch = await withEnv("GRAPHIFY_OUT", undefined, () =>
      prepareClaudeLaunch(makeContext([{ name: "graphify" }]), []),
    );

    expect(launch.env.GRAPHIFY_OUT).toBe(
      path.join("/tmp/companion", ".graphify", "app", "graphify-out"),
    );
    expect(launch.env.GRAPHIFY_OUT).toBe(projectionOf(makeContext()).graphifyOut);
    expect(launch.env.MATE_GRAPHIFY_ENABLED).toBe("1");
  });

  test("sets GRAPHIFY_OUT when graphify capability is absent, matching the projection", async () => {
    const launch = await withEnv("GRAPHIFY_OUT", undefined, () =>
      prepareClaudeLaunch(makeContext(), []),
    );

    expect(launch.env.GRAPHIFY_OUT).toBe(projectionOf(makeContext()).graphifyOut);
    expect(launch.env.MATE_GRAPHIFY_ENABLED).toBe("0");
  });
});

describe("openspec capability env injection", () => {
  test("marks openspec enabled only when the capability is selected", async () => {
    const enabled = await prepareClaudeLaunch(makeContext([{ name: "openspec" }]), []);
    const disabled = await prepareClaudeLaunch(makeContext(), []);

    expect(enabled.env.MATE_OPENSPEC_ENABLED).toBe("1");
    expect(disabled.env.MATE_OPENSPEC_ENABLED).toBe("0");
  });

  test("carries the git auto mode state alongside the openspec flag", async () => {
    const context = { ...makeContext([{ name: "openspec" }]), git: "auto" as const };
    const launch = await prepareClaudeLaunch(context, []);

    expect(launch.env.MATE_OPENSPEC_ENABLED).toBe("1");
    expect(launch.env.MATE_GIT_AUTO_MODE).toBe("1");
  });

  test("clears git auto mode when the launch bypasses synchronization", async () => {
    const context = { ...makeContext(), git: "auto" as const, skipGit: true };
    const launch = await prepareClaudeLaunch(context, []);

    expect(launch.env.MATE_GIT_AUTO_MODE).toBe("0");
  });
});

describe("react-doctor capability env injection", () => {
  test("marks react-doctor enabled only when the capability is selected", async () => {
    const enabled = await prepareClaudeLaunch(makeContext([{ name: "react-doctor" }]), []);
    const disabled = await prepareClaudeLaunch(makeContext(), []);

    expect(enabled.env.MATE_REACT_DOCTOR_ENABLED).toBe("1");
    expect(enabled.env.MATE_REACT_DOCTOR_BIN_PATH).toBe(getReactDoctorBinPath());
    expect(getReactDoctorBinPath()).toMatch(/[\\/]react-doctor[\\/]bin[\\/]react-doctor\.js$/);
    await fs.access(getReactDoctorBinPath());
    expect(disabled.env.MATE_REACT_DOCTOR_ENABLED).toBe("0");
    expect(disabled.env.MATE_REACT_DOCTOR_BIN_PATH).toBeUndefined();
  });
});

describe("launch PATH injection", () => {
  test("prepends only the Mate wrapper dir when tokensave is enabled", async () => {
    const launch = await withEnv("PATH", "/usr/bin", () =>
      prepareClaudeLaunch(makeContext([{ name: "tokensave" }]), []),
    );

    expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}/usr/bin`);
    expect(launch.env.PATH).toBe(
      `${projectionOf(makeContext()).wrapperBinPath}${path.delimiter}/usr/bin`,
    );
    expect(launch.env.PATH).not.toContain(".tokensave");
  });

  test("PATH is unchanged when tokensave capability is absent", async () => {
    const launch = await withEnv("PATH", "/usr/bin", () => prepareClaudeLaunch(makeContext(), []));

    expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}/usr/bin`);
  });
});

/**
 * Where the migrated assertions land: the launch environment is the projected
 * record materialized, so every path assertion above is an assertion about the
 * file `mate wrap` writes.
 */
describe("launch environment and the projection agree", () => {
  test("materializes every projected field under its projection env name", async () => {
    const context = makeContext([{ name: "react-doctor" }]);
    const launch = await prepareClaudeLaunch(context, []);
    const projection = projectionOf(context);

    for (const field of PROJECTION_FIELDS) {
      expect(launch.env[PROJECTION_ENV_NAMES[field]]).toBe(projection[field]);
    }
  });

  test("resolves the same Graphify output path through a launch and through a projection", async () => {
    const { repoRoot, repository, companionPath } =
      await wrappedRepository("mate-launch-graphify-");

    const enabled = await prepareClaudeLaunch(
      { ...makeContext([{ name: "graphify" }]), repository, companionPath },
      [],
    );
    const disabled = await prepareClaudeLaunch({ ...makeContext(), repository, companionPath }, []);

    expect(enabled.env.GRAPHIFY_OUT).toBe(resolveProjection(repoRoot)?.graphifyOut);
    expect(disabled.env.GRAPHIFY_OUT).toBe(resolveProjection(repoRoot)?.graphifyOut);
  });

  /** Migrated: the grants now reach every session through the wrapped document only. */
  test("leaves the companion directory grants to the wrapped OpenCode document", async () => {
    const launch = await withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
      new OpenCodeAdapter(OPENCODE_V2).prepareLaunch(makeContext(), []),
    );

    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  test("the launch environment outranks the projection for every reader", async () => {
    const { repoRoot, repository, companionPath } =
      await wrappedRepository("mate-launch-outranks-");
    const launched = path.join(repoRoot, "launched-companion");

    const launch = await prepareClaudeLaunch(
      { ...makeContext(), repository, companionPath: launched },
      [],
    );

    expect(resolveProjection(repoRoot)?.companionPath).toBe(companionPath);
    expect(readCompanionRuntimeContext(launch.env, repoRoot).companionPath).toBe(launched);
  });
});

describe("Claude companion settings launch flags", () => {
  test("adds --setting-sources and --settings for the settings file the plan chose", async () => {
    const { companionPath } = await claudeCompanion("mate-claude-settings-flag-");

    const args = await claudeArgs({ ...makeContext(), companionPath }, ["--print", "hello"]);

    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user,project,local");
    expect(args[args.indexOf("--settings") + 1]).toBe(launchSettingsPath(companionPath, "app"));
    // Passthrough args stay after the managed settings flags.
    expect(args.slice(-2)).toEqual(["--print", "hello"]);
  });

  test("omits settings and MCP flags when the companion holds no file", async () => {
    const args = await claudeArgs(makeContext(), []);

    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--mcp-config");
    expect(args[0]).toBe("--append-system-prompt");
  });

  test("ignores an MCP config the plan does not route through --mcp-config", async () => {
    const { companionPath } = await claudeCompanion("mate-claude-mcp-flag-", { mcpConfig: true });

    const args = await claudeArgs({ ...makeContext(), companionPath }, []);

    expect(args).not.toContain("--mcp-config");
  });

  test("a companion-scoped plan passes the companion directly", async () => {
    const { repository: _repository, ...companionScoped } = makeContext();
    const { companionPath, settingsPath, mcpConfigPath } = await claudeCompanion(
      "mate-claude-companion-flags-",
      { mcpConfig: true },
    );

    const args = await claudeArgs(
      { ...companionScoped, companionPath, launchWorkingDirectory: companionPath },
      ["--print", "hello"],
    );

    expect(args.slice(0, 2)).toEqual(["--add-dir", companionPath]);
    expect(args[args.indexOf("--settings") + 1]).toBe(settingsPath);
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(mcpConfigPath);
    /** Passthrough args stay after the managed flags. */
    expect(args.slice(-2)).toEqual(["--print", "hello"]);
  });

  test("a managed-repo plan passes the deferred set and defers hooks, MCP and dir access", async () => {
    const { companionPath } = await claudeCompanion("mate-claude-managed-repo-flags-", {
      mcpConfig: true,
    });
    const context = {
      ...makeContext([{ name: "context-mode" }]),
      repository: { id: "acme", path: "/acme/repo" },
      companionPath,
    };

    /** context-mode's folder reaches the launch as its prepare gathered it, like any Capability's. */
    const args = await claudeArgs(context, ["--print"], [getContextModePackageRoot(companionPath)]);

    expect(args).toEqual([
      "--append-system-prompt",
      args[1]!,
      "--setting-sources",
      "user,project,local",
      "--settings",
      launchSettingsPath(companionPath, "acme"),
      "--plugin-dir",
      getClaudePluginRoot(),
      "--plugin-dir",
      getContextModePackageRoot(companionPath),
      "--print",
    ]);
  });

  test("always loads the bundled mate plugin directory", async () => {
    const companionPath = await makeTempDir("mate-claude-plugin-flag-");
    const args = await claudeArgs({ ...makeContext(), companionPath }, []);

    const pluginDirs = args.filter((_, index) => args[index - 1] === "--plugin-dir");
    expect(pluginDirs).toEqual([getClaudePluginRoot()]);
  });

  /**
   * Migrated: "adds the local context-mode plugin directory only when enabled"
   * read the capability list here. The adapter now passes what its prepare
   * gathered, so the behavior is asserted where it lives: context-mode declares
   * its folder and a sync pass gathers it (`context-mode.test.ts`), a disabled
   * Capability's folder is not gathered (`engine-reconcile.test.ts`), the
   * adapter passes gathered folders after the bundled plugin (`claude.test.ts`),
   * and an enabled context-mode still yields the same two flags
   * (`context-mode-launch.test.ts`).
   */
  test("passes a capability-only context-mode no plugin folder of its own", async () => {
    const companionPath = await makeTempDir("mate-claude-context-mode-flag-");
    const args = await claudeArgs(
      { ...makeContext([{ name: "context-mode" }]), companionPath },
      [],
    );

    const pluginDirs = args.filter((_, index) => args[index - 1] === "--plugin-dir");
    expect(pluginDirs).toEqual([getClaudePluginRoot()]);
  });

  test("validates the bundled mate plugin assets", async () => {
    // The real bundled plugin is present, so a managed launch validates.
    await expect(
      new ClaudeAdapter().validateLaunch(await planClaude(makeContext())),
    ).resolves.toBeUndefined();

    // A broken installation fails naming the missing assets.
    const broken = await makeTempDir("mate-claude-plugin-broken-");
    expect(() => validateClaudePluginAssets(broken)).toThrow(/plugin\.json/);
    expect(() => validateClaudePluginAssets(broken)).toThrow(/validate-artifact-path\.mjs/);
  });
});

describe("Adapter base-URL rewriting is gone", () => {
  test("ClaudeAdapter sets no ANTHROPIC_BASE_URL of Mate's own", async () => {
    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      prepareClaudeLaunch(makeContext(), []),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  /**
   * Migrated from the launch overlay: references, permissions, skills and the
   * plugin root are asserted on the wrapped document in
   * `tools/setup/runtime-documents.test.ts`.
   */
  test("OpenCodeAdapter sets neither OPENCODE_CONFIG_DIR nor a config overlay", async () => {
    const launch = await withEnv("OPENCODE_CONFIG_DIR", undefined, () =>
      withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
        new OpenCodeAdapter(OPENCODE_V2).prepareLaunch(makeContext(), []),
      ),
    );

    expect(launch.env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(launch.env.MATE_GUIDANCE_JSON).toBeDefined();
  });

  test("OpenCodeAdapter passes an inherited config dir and overlay through unchanged", async () => {
    const inherited = JSON.stringify({
      model: "anthropic/test",
      plugins: ["opencode-acme-plugin"],
    });
    const launch = await withEnv("OPENCODE_CONFIG_DIR", "/home/acme/.config/acme", () =>
      withEnv("OPENCODE_CONFIG_CONTENT", inherited, () =>
        new OpenCodeAdapter(OPENCODE_V2).prepareLaunch(makeContext(), []),
      ),
    );

    expect(launch.env.OPENCODE_CONFIG_DIR).toBe("/home/acme/.config/acme");
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBe(inherited);
  });

  test("OpenCodeAdapter contributes no provider baseURL", async () => {
    const companionPath = await makeTempDir("mate-opencode-companion-");
    await fs.mkdir(path.join(companionPath, ".opencode", "plugins"), { recursive: true });
    await fs.writeFile(path.join(companionPath, ".opencode", "opencode.json"), "{}\n", "utf8");
    await fs.writeFile(
      path.join(companionPath, ".opencode", "plugins", "mate-add-dir.ts"),
      "export {};\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(companionPath, ".opencode", "plugins", "mate-companion.ts"),
      "export {};\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(companionPath, ".opencode", "plugins", "mate-companion-policy.ts"),
      "export {};\n",
      "utf8",
    );

    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      withEnv("OPENAI_BASE_URL", undefined, () =>
        withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
          new OpenCodeAdapter(OPENCODE_V2).prepareLaunch({ ...makeContext(), companionPath }, []),
        ),
      ),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  test("injects no custom Anthropic headers, whichever companion is launched", async () => {
    const firstLaunch = await withEnv("ANTHROPIC_CUSTOM_HEADERS", undefined, () =>
      prepareClaudeLaunch(makeContext(), []),
    );
    const secondLaunch = await withEnv("ANTHROPIC_CUSTOM_HEADERS", undefined, () =>
      prepareClaudeLaunch({ ...makeContext(), companionPath: "/tmp/other-companion" }, []),
    );

    expect(firstLaunch.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(secondLaunch.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  test("OpenCodeAdapter sets neither provider base URL of Mate's own", async () => {
    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      withEnv("OPENAI_BASE_URL", undefined, () =>
        withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
          new OpenCodeAdapter(OPENCODE_V2).prepareLaunch(makeContext(), []),
        ),
      ),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
  });
});
