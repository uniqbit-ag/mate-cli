import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { getContextModePackageReference } from "../../../lib/context-mode-package";
import { applySetupCompatibilities } from "../../setup";
import type { LaunchPreflightContext, SetupContext } from "../plugin";
import { createClaudePlugin } from "../providers/claude";
import { createOpenCodePlugin } from "../providers/opencode";
import { CONTEXT_MODE_OPENCODE_GUIDANCE, createContextModePlugin } from "./context-mode";

const tempRoots: string[] = [];

async function makeContext(): Promise<SetupContext> {
  const companionPath = await fs.mkdtemp(path.join(os.tmpdir(), "mate-context-mode-"));
  tempRoots.push(companionPath);
  await fs.mkdir(path.join(companionPath, ".opencode"), { recursive: true });
  return {
    companionPath,
    mode: "sync",
    activeProviders: ["claude", "opencode"],
    config: {
      profiles: { default: { name: "default", allowedAgents: ["claude", "opencode"] } },
      capabilities: [{ name: "context-mode" }],
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createContextModePlugin", () => {
  test("is optional and selected by its capability name", () => {
    const plugin = createContextModePlugin();
    expect(plugin.defaultSelected).toBe(false);
    expect(plugin.isEnabled({ profiles: {}, capabilities: [{ name: "context-mode" }] })).toBe(true);
    expect(plugin.isEnabled({ profiles: {}, capabilities: [] })).toBe(false);
  });

  test("provisions only during setup and validates during launch sync", async () => {
    const ctx = await makeContext();
    const installPackage = mock(async () => {});
    const validatePackage = mock(async () => {});
    const plugin = createContextModePlugin({ installPackage, validatePackage });

    await plugin.apply({ ...ctx, mode: "setup" });
    await plugin.apply(ctx);

    expect(installPackage).toHaveBeenCalledTimes(1);
    expect(validatePackage).toHaveBeenCalledTimes(1);
  });

  test("adds the exact OpenCode reference after existing plugins idempotently", async () => {
    const ctx = await makeContext();
    const configPath = path.join(ctx.companionPath, ".opencode", "opencode.json");
    const tuiPath = path.join(ctx.companionPath, ".opencode", "tui.json");
    await fs.writeFile(configPath, JSON.stringify({ plugin: ["acme-plugin@1.0.0"] }));
    await fs.writeFile(tuiPath, "{}\n");
    const handler = createContextModePlugin().forProvider?.opencode;

    await handler?.apply(ctx);
    await handler?.apply(ctx);

    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(config.plugin).toEqual(["acme-plugin@1.0.0", getContextModePackageReference()]);
  });

  test("preflight validates both pinned OpenCode references without modifying files", async () => {
    const ctx = await makeContext();
    const configPath = path.join(ctx.companionPath, ".opencode", "opencode.json");
    const tuiPath = path.join(ctx.companionPath, ".opencode", "tui.json");
    const expected = getContextModePackageReference();
    await fs.writeFile(configPath, JSON.stringify({ plugin: [expected] }));
    await fs.writeFile(tuiPath, JSON.stringify({ plugin: [expected] }));
    const before = await Promise.all([
      fs.readFile(configPath, "utf8"),
      fs.readFile(tuiPath, "utf8"),
    ]);
    const preflight = createContextModePlugin().forProvider?.opencode?.preflight;
    const launchContext: LaunchPreflightContext = {
      companionPath: ctx.companionPath,
      config: ctx.config,
      repository: { id: "acme", path: "/tmp/acme", profile: "default" },
      providerId: "opencode",
    };

    await expect(preflight?.(launchContext)).resolves.toEqual([]);
    expect(
      await Promise.all([fs.readFile(configPath, "utf8"), fs.readFile(tuiPath, "utf8")]),
    ).toEqual(before);
  });

  test("preflight reports missing and stale references in each affected file", async () => {
    const ctx = await makeContext();
    const configPath = path.join(ctx.companionPath, ".opencode", "opencode.json");
    await fs.writeFile(configPath, JSON.stringify({ plugin: ["context-mode@0.0.1"] }));
    const preflight = createContextModePlugin().forProvider?.opencode?.preflight;

    const diagnostics = await preflight?.({
      companionPath: ctx.companionPath,
      config: ctx.config,
      repository: { id: "acme", path: "/tmp/acme", profile: "default" },
      providerId: "opencode",
    });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics?.[0]).toContain(configPath);
    expect(diagnostics?.[1]).toContain(path.join(ctx.companionPath, ".opencode", "tui.json"));
    expect(
      diagnostics?.every((diagnostic) => diagnostic.includes(getContextModePackageReference())),
    ).toBe(true);
  });

  test("teardown removes only references that Mate added", async () => {
    const ctx = await makeContext();
    const configPath = path.join(ctx.companionPath, ".opencode", "opencode.json");
    const tuiPath = path.join(ctx.companionPath, ".opencode", "tui.json");
    await fs.writeFile(configPath, JSON.stringify({ plugin: ["acme-plugin@1.0.0"] }));
    await fs.writeFile(
      tuiPath,
      JSON.stringify({ plugin: [getContextModePackageReference(), "user-plugin@2.0.0"] }),
    );
    const handler = createContextModePlugin().forProvider?.opencode;

    await handler?.apply(ctx);
    await handler?.teardown(ctx);

    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const tui = JSON.parse(await fs.readFile(tuiPath, "utf8"));
    expect(config.plugin).toEqual(["acme-plugin@1.0.0"]);
    expect(tui.plugin).toEqual([getContextModePackageReference(), "user-plugin@2.0.0"]);
  });

  test("teardown leaves unowned and malformed provider configuration untouched", async () => {
    const ctx = await makeContext();
    const configPath = path.join(ctx.companionPath, ".opencode", "opencode.json");
    await fs.writeFile(configPath, "{ not json\n");

    await createContextModePlugin().forProvider?.opencode?.teardown(ctx);

    expect(await fs.readFile(configPath, "utf8")).toBe("{ not json\n");
  });

  test("blocks duplicate MCP and mismatched native configuration without changing it", async () => {
    const ctx = await makeContext();
    const configPath = path.join(ctx.companionPath, ".opencode", "opencode.json");
    const original = {
      mcp: { contextMode: { command: ["context-mode"] } },
      plugin: ["context-mode@1.0.1"],
    };
    await fs.writeFile(configPath, JSON.stringify(original));
    await fs.writeFile(path.join(ctx.companionPath, ".opencode", "tui.json"), "{}\n");

    await expect(createContextModePlugin().forProvider?.opencode?.apply(ctx)).rejects.toThrow(
      "already contains a context-mode MCP registration",
    );
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(original);
  });

  test("reconciles OpenCode-only guidance idempotently and removes only its owned block", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-context-mode-guidance-"));
    tempRoots.push(root);
    const contextMode = createContextModePlugin({
      installPackage: async () => {},
      validatePackage: async () => {},
      warmOpenCodePackage: async () => ({ ok: true }),
    });
    const plugins = [createClaudePlugin(), createOpenCodePlugin(), contextMode];
    const enabled = {
      profiles: {
        default: { name: "default", allowedAgents: ["claude", "opencode"] },
      },
      capabilities: [{ name: "context-mode" }],
    };

    await applySetupCompatibilities(root, enabled, "sync", plugins);
    await applySetupCompatibilities(root, enabled, "sync", plugins);

    const agentsPath = path.join(root, "AGENTS.md");
    const claudePath = path.join(root, "CLAUDE.md");
    const agents = await fs.readFile(agentsPath, "utf8");
    expect(agents.split(CONTEXT_MODE_OPENCODE_GUIDANCE).length - 1).toBe(1);
    expect(await fs.readFile(claudePath, "utf8")).not.toContain(CONTEXT_MODE_OPENCODE_GUIDANCE);

    await fs.appendFile(agentsPath, "\nUser-authored acme guidance.\n", "utf8");
    await applySetupCompatibilities(root, { ...enabled, capabilities: [] }, "sync", plugins);

    const cleanedAgents = await fs.readFile(agentsPath, "utf8");
    expect(cleanedAgents).not.toContain(CONTEXT_MODE_OPENCODE_GUIDANCE);
    expect(cleanedAgents).toContain("User-authored acme guidance.");
  });

  test("does not contribute OpenCode guidance when OpenCode is inactive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-context-mode-no-opencode-"));
    tempRoots.push(root);
    const contextMode = createContextModePlugin({
      installPackage: async () => {},
      validatePackage: async () => {},
    });

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "context-mode" }],
      },
      "sync",
      [createClaudePlugin(), createOpenCodePlugin(), contextMode],
    );

    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).not.toContain(
      CONTEXT_MODE_OPENCODE_GUIDANCE,
    );
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).not.toContain(
      CONTEXT_MODE_OPENCODE_GUIDANCE,
    );
  });
});
