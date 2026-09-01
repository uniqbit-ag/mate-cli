import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

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
import { renderCompanionExternalDirectoryPermissions } from "../../../tools/setup/providers/opencode";
import { getContextModePackageRoot } from "../../context-mode-package";
import { getOpenCodePluginPackageReference } from "../../opencode-plugin-package";
import {
  getClaudePluginRoot,
  getReactDoctorBinPath,
  getWrapperBinPath,
  validateClaudePluginAssets,
} from "../../package-paths";
import { ClaudeAdapter } from "./claude";
import { OpenCodeAdapter } from "./opencode";
import type { AdapterContext } from "./base";
import { withEnv } from "../../../../test/helpers";

const tempRoots: string[] = [];

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

function makeContext(capabilities: AdapterContext["capabilities"] = []): AdapterContext {
  return {
    repository: {
      id: "app",
      path: "/tmp/app",
    },
    allowedAgents: ["claude", "opencode"],
    companionPath: "/tmp/companion",
    capabilities,
  };
}

function projectionOf(context: AdapterContext) {
  return buildProjection(context.companionPath, context.repository);
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

async function writeOpenCodeRuntime(
  companionPath: string,
  pluginReference: string = getOpenCodePluginPackageReference(),
): Promise<void> {
  await fs.mkdir(path.join(companionPath, ".opencode"), { recursive: true });
  await fs.writeFile(
    path.join(companionPath, ".opencode", "opencode.json"),
    JSON.stringify({ plugin: [pluginReference] }, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(companionPath, ".opencode", "tui.json"),
    JSON.stringify({ plugin: [pluginReference] }, null, 2) + "\n",
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("LaunchAdapter.prepareLaunch", () => {
  test("builds the Claude invocation without rewriting the model base URL", async () => {
    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      new ClaudeAdapter().prepareLaunch(makeContext(), ["--print", "hello"]),
    );

    expect(launch.command).toBe("claude");
    expect(launch.args[0]).toBe("--add-dir");
    expect(launch.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("an unrecognized capability leaves the OpenCode invocation and PATH untouched", async () => {
    const binDir = await makeTempDir("mate-launch-bin-");

    await withPath(binDir, async () => {
      const launch = await new OpenCodeAdapter().prepareLaunch(
        makeContext([{ name: "retired-capability" }]),
        ["--mode", "chat"],
      );

      expect(launch.command).toBe("opencode");
      expect(launch.args).toContain("--mode");
      expect(launch.args).toContain("chat");
      expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}${binDir}`);
    });
  });

  test("validates the required OpenCode companion plugin before launch", async () => {
    const companionPath = await makeTempDir("mate-opencode-companion-");
    await writeOpenCodeRuntime(companionPath);

    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath }),
    ).resolves.toBeUndefined();
  });

  test("fails OpenCode launch validation when the companion plugin is missing", async () => {
    const companionPath = await makeTempDir("mate-opencode-missing-");

    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath }),
    ).rejects.toThrow(LaunchPreflightError);
    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath }),
    ).rejects.toThrow(/OpenCode companion runtime is incomplete/);
  });

  test("fails OpenCode launch validation when the plugin package reference is missing or stale", async () => {
    const missingPath = await makeTempDir("mate-opencode-missing-plugin-ref-");
    await writeOpenCodeRuntime(missingPath);
    await fs.writeFile(path.join(missingPath, ".opencode", "opencode.json"), "{}\n", "utf8");

    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath: missingPath }),
    ).rejects.toThrow(/Missing Mate plugin package reference in .opencode\/opencode\.json/);

    const stalePath = await makeTempDir("mate-opencode-stale-plugin-ref-");
    await writeOpenCodeRuntime(stalePath, "@uniqbit/mate-opencode-plugin@0.0.1");

    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath: stalePath }),
    ).rejects.toThrow(/Stale Mate plugin package reference/);
    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath: stalePath }),
    ).rejects.toThrow(/Expected Mate plugin package: @uniqbit\/mate-opencode-plugin@/);
  });

  test("leaves context-mode package validation to the capability plugin", async () => {
    const companionPath = await makeTempDir("mate-opencode-context-mode-");
    await writeOpenCodeRuntime(companionPath);
    const context = { ...makeContext([{ name: "context-mode" }]), companionPath };

    await expect(new OpenCodeAdapter().validateLaunch(context)).resolves.toBeUndefined();
    await fs.writeFile(
      path.join(companionPath, ".opencode", "opencode.json"),
      JSON.stringify({ plugin: [getOpenCodePluginPackageReference(), "context-mode@0.0.1"] }),
    );
    await expect(new OpenCodeAdapter().validateLaunch(context)).resolves.toBeUndefined();
  });

  test("injects the companion guidance payload into the OpenCode launch environment", async () => {
    const adapter = new OpenCodeAdapter();

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

  test("propagates real capabilities into companionGuidance, matching the Claude provider", async () => {
    const adapter = new OpenCodeAdapter();

    // Regression test: buildOpenCodeGuidance previously hardcoded an empty
    // capabilities array when calling buildCompanionGuidance, so
    // capability-gated rules (e.g. openspec-finish) never rendered for
    // OpenCode regardless of what was actually enabled.
    const openspecEnv = adapter.extendEnvironment(makeContext([{ name: "openspec" }]));
    const openspecGuidance = JSON.parse(openspecEnv.MATE_GUIDANCE_JSON ?? "{}");
    expect(openspecGuidance.companionGuidance).toContain("openspec-finish");

    const withoutOpenspecEnv = adapter.extendEnvironment(makeContext([{ name: "tokensave" }]));
    const withoutOpenspecGuidance = JSON.parse(withoutOpenspecEnv.MATE_GUIDANCE_JSON ?? "{}");
    expect(withoutOpenspecGuidance.companionGuidance).not.toContain("openspec-finish");

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
      new ClaudeAdapter().prepareLaunch(makeContext([{ name: "graphify" }]), []),
    );

    expect(launch.env.GRAPHIFY_OUT).toBe(
      path.join("/tmp/companion", ".graphify", "app", "graphify-out"),
    );
    expect(launch.env.GRAPHIFY_OUT).toBe(projectionOf(makeContext()).graphifyOut);
    expect(launch.env.MATE_GRAPHIFY_ENABLED).toBe("1");
  });

  test("sets GRAPHIFY_OUT when graphify capability is absent, matching the projection", async () => {
    const launch = await withEnv("GRAPHIFY_OUT", undefined, () =>
      new ClaudeAdapter().prepareLaunch(makeContext(), []),
    );

    expect(launch.env.GRAPHIFY_OUT).toBe(projectionOf(makeContext()).graphifyOut);
    expect(launch.env.MATE_GRAPHIFY_ENABLED).toBe("0");
  });
});

describe("openspec archive-nudge gate env injection", () => {
  test("marks openspec enabled only when the capability is selected", async () => {
    const enabled = await new ClaudeAdapter().prepareLaunch(
      makeContext([{ name: "openspec" }]),
      [],
    );
    const disabled = await new ClaudeAdapter().prepareLaunch(makeContext(), []);

    expect(enabled.env.MATE_OPENSPEC_ENABLED).toBe("1");
    expect(disabled.env.MATE_OPENSPEC_ENABLED).toBe("0");
  });

  test("carries the git auto mode state alongside the openspec flag", async () => {
    const context = { ...makeContext([{ name: "openspec" }]), git: "auto" as const };
    const launch = await new ClaudeAdapter().prepareLaunch(context, []);

    expect(launch.env.MATE_OPENSPEC_ENABLED).toBe("1");
    expect(launch.env.MATE_GIT_AUTO_MODE).toBe("1");
  });
});

describe("react-doctor capability env injection", () => {
  test("marks react-doctor enabled only when the capability is selected", async () => {
    const enabled = await new ClaudeAdapter().prepareLaunch(
      makeContext([{ name: "react-doctor" }]),
      [],
    );
    const disabled = await new ClaudeAdapter().prepareLaunch(makeContext(), []);

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
      new ClaudeAdapter().prepareLaunch(makeContext([{ name: "tokensave" }]), []),
    );

    expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}/usr/bin`);
    expect(launch.env.PATH).toBe(
      `${projectionOf(makeContext()).wrapperBinPath}${path.delimiter}/usr/bin`,
    );
    expect(launch.env.PATH).not.toContain(".tokensave");
  });

  test("PATH is unchanged when tokensave capability is absent", async () => {
    const launch = await withEnv("PATH", "/usr/bin", () =>
      new ClaudeAdapter().prepareLaunch(makeContext(), []),
    );

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
    const launch = await new ClaudeAdapter().prepareLaunch(context, []);
    const projection = projectionOf(context);

    for (const field of PROJECTION_FIELDS) {
      expect(launch.env[PROJECTION_ENV_NAMES[field]]).toBe(projection[field]);
    }
  });

  test("resolves the same Graphify output path through a launch and through a projection", async () => {
    const { repoRoot, repository, companionPath } =
      await wrappedRepository("mate-launch-graphify-");

    const enabled = await new ClaudeAdapter().prepareLaunch(
      { ...makeContext([{ name: "graphify" }]), repository, companionPath },
      [],
    );
    const disabled = await new ClaudeAdapter().prepareLaunch(
      { ...makeContext(), repository, companionPath },
      [],
    );

    expect(enabled.env.GRAPHIFY_OUT).toBe(resolveProjection(repoRoot)?.graphifyOut);
    expect(disabled.env.GRAPHIFY_OUT).toBe(resolveProjection(repoRoot)?.graphifyOut);
  });

  test("grants the same companion directories a projected OpenCode document would", async () => {
    const context = makeContext();
    const launch = await withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
      new OpenCodeAdapter().prepareLaunch(context, []),
    );

    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission.external_directory).toEqual(
      renderCompanionExternalDirectoryPermissions(context.companionPath),
    );
  });

  test("the launch environment outranks the projection for every reader", async () => {
    const { repoRoot, repository, companionPath } =
      await wrappedRepository("mate-launch-outranks-");
    const launched = path.join(repoRoot, "launched-companion");

    const launch = await new ClaudeAdapter().prepareLaunch(
      { ...makeContext(), repository, companionPath: launched },
      [],
    );

    expect(resolveProjection(repoRoot)?.companionPath).toBe(companionPath);
    expect(readCompanionRuntimeContext(launch.env, repoRoot).companionPath).toBe(launched);
  });
});

describe("Claude companion settings launch flags", () => {
  test("adds --setting-sources and --settings when companion settings exist", async () => {
    const companionPath = await makeTempDir("mate-claude-settings-flags-");
    const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, "{}\n", "utf8");

    const launch = await new ClaudeAdapter().prepareLaunch({ ...makeContext(), companionPath }, [
      "--print",
      "hello",
    ]);

    expect(launch.args).toContain("--setting-sources");
    const sourcesIndex = launch.args.indexOf("--setting-sources");
    expect(launch.args[sourcesIndex + 1]).toBe("user,project,local");
    expect(launch.args).toContain("--settings");
    const settingsIndex = launch.args.indexOf("--settings");
    expect(launch.args[settingsIndex + 1]).toBe(settingsPath);
    // Passthrough args stay after the managed settings flags.
    expect(launch.args.slice(-2)).toEqual(["--print", "hello"]);
  });

  test("omits settings flags when companion settings file is absent", async () => {
    const companionPath = await makeTempDir("mate-claude-settings-none-");

    const launch = await new ClaudeAdapter().prepareLaunch({ ...makeContext(), companionPath }, []);

    expect(launch.args).not.toContain("--setting-sources");
    expect(launch.args).not.toContain("--settings");
    expect(launch.args).not.toContain("--mcp-config");
    expect(launch.args[0]).toBe("--add-dir");
  });

  test("adds --mcp-config when companion .mcp.json exists", async () => {
    const companionPath = await makeTempDir("mate-claude-mcp-flag-");
    const mcpConfigPath = path.join(companionPath, ".mcp.json");
    await fs.writeFile(mcpConfigPath, '{"mcpServers":{}}\n', "utf8");

    const launch = await new ClaudeAdapter().prepareLaunch({ ...makeContext(), companionPath }, [
      "--print",
      "hello",
    ]);

    expect(launch.args).toContain("--mcp-config");
    const mcpIndex = launch.args.indexOf("--mcp-config");
    expect(launch.args[mcpIndex + 1]).toBe(mcpConfigPath);
    // Passthrough args stay after the managed flags.
    expect(launch.args.slice(-2)).toEqual(["--print", "hello"]);
  });

  test("always loads the bundled mate plugin directory", async () => {
    const companionPath = await makeTempDir("mate-claude-plugin-flag-");
    const args = new ClaudeAdapter().buildArgs({ ...makeContext(), companionPath }, []);

    const pluginDirs = args.filter((_, index) => args[index - 1] === "--plugin-dir");
    expect(pluginDirs).toEqual([getClaudePluginRoot()]);
  });

  test("adds the local context-mode plugin directory only when enabled, alongside the mate plugin", async () => {
    const companionPath = await makeTempDir("mate-claude-context-mode-flag-");
    const enabled = new ClaudeAdapter().buildArgs(
      { ...makeContext([{ name: "context-mode" }]), companionPath },
      [],
    );
    const disabled = new ClaudeAdapter().buildArgs({ ...makeContext(), companionPath }, []);

    const enabledPluginDirs = enabled.filter((_, index) => enabled[index - 1] === "--plugin-dir");
    expect(enabledPluginDirs).toEqual([
      getClaudePluginRoot(),
      getContextModePackageRoot(companionPath),
    ]);
    const disabledPluginDirs = disabled.filter(
      (_, index) => disabled[index - 1] === "--plugin-dir",
    );
    expect(disabledPluginDirs).toEqual([getClaudePluginRoot()]);
  });

  test("validates the bundled mate plugin assets", async () => {
    // The real bundled plugin is present, so a managed launch validates.
    await expect(new ClaudeAdapter().validateLaunch(makeContext())).resolves.toBeUndefined();

    // A broken installation fails naming the missing assets.
    const broken = await makeTempDir("mate-claude-plugin-broken-");
    expect(() => validateClaudePluginAssets(broken)).toThrow(/plugin\.json/);
    expect(() => validateClaudePluginAssets(broken)).toThrow(/validate-artifact-path\.mjs/);
  });
});

describe("Adapter base-URL rewriting is gone", () => {
  test("ClaudeAdapter sets no ANTHROPIC_BASE_URL of Mate's own", async () => {
    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      new ClaudeAdapter().prepareLaunch(makeContext(), []),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("OpenCodeAdapter injects the mate reference through OPENCODE_CONFIG_CONTENT", async () => {
    const launch = await withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
      new OpenCodeAdapter().prepareLaunch(makeContext(), []),
    );

    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.references.mate).toBe("/tmp/companion");
    expect(config.permission.external_directory["/tmp/companion"]).toBe("allow");
    expect(config.permission.external_directory["/tmp/companion/**"]).toBe("allow");
    expect(config.skills.paths).toEqual(["/tmp/companion/.agents/skills"]);
  });

  test("OpenCodeAdapter merges the mate reference and permissions with inherited OPENCODE_CONFIG_CONTENT", async () => {
    const launch = await withEnv(
      "OPENCODE_CONFIG_CONTENT",
      JSON.stringify({
        model: "anthropic/test",
        permission: { external_directory: { "../docs/**": "allow" } },
        references: { docs: "../docs" },
        skills: { paths: ["../team-skills"] },
      }),
      () => new OpenCodeAdapter().prepareLaunch(makeContext(), []),
    );

    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission.external_directory["../docs/**"]).toBe("allow");
    expect(config.permission.external_directory["/tmp/companion"]).toBe("allow");
    expect(config.permission.external_directory["/tmp/companion/**"]).toBe("allow");
    expect(config.references.docs).toBe("../docs");
    expect(config.references.mate).toBe("/tmp/companion");
    expect(config.skills.paths).toEqual(["../team-skills", "/tmp/companion/.agents/skills"]);
    expect(config.model).toBe("anthropic/test");
  });

  test("OpenCodeAdapter contributes no provider baseURL while still projecting the companion", async () => {
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
          new OpenCodeAdapter().prepareLaunch({ ...makeContext(), companionPath }, []),
        ),
      ),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.references.mate).toBe(companionPath);
    expect(config.permission.external_directory[companionPath]).toBe("allow");
    expect(config.permission.external_directory[`${companionPath}/**`]).toBe("allow");
    expect(config.provider).toBeUndefined();
  });

  test("injects no custom Anthropic headers, whichever companion is launched", async () => {
    const firstLaunch = await withEnv("ANTHROPIC_CUSTOM_HEADERS", undefined, () =>
      new ClaudeAdapter().prepareLaunch(makeContext(), []),
    );
    const secondLaunch = await withEnv("ANTHROPIC_CUSTOM_HEADERS", undefined, () =>
      new ClaudeAdapter().prepareLaunch(
        { ...makeContext(), companionPath: "/tmp/other-companion" },
        [],
      ),
    );

    expect(firstLaunch.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(secondLaunch.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  test("OpenCodeAdapter sets neither provider base URL of Mate's own", async () => {
    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      withEnv("OPENAI_BASE_URL", undefined, () =>
        withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
          new OpenCodeAdapter().prepareLaunch(makeContext(), []),
        ),
      ),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.references.mate).toBe("/tmp/companion");
    expect(config.permission.external_directory["/tmp/companion"]).toBe("allow");
    expect(config.permission.external_directory["/tmp/companion/**"]).toBe("allow");
  });
});
