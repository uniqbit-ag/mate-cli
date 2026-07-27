// oxlint-disable no-await-in-loop -- config files are reconciled sequentially with shared ownership state
import fs from "node:fs/promises";
import path from "node:path";

import {
  CONTEXT_MODE_PACKAGE_NAME,
  getContextModeInstallDir,
  getContextModePackageReference,
  installContextModePackage,
  isContextModePackageReference,
  validateContextModePackage,
} from "../../../lib/context-mode-package";
import { warmOpenCodePackageCache } from "../../../lib/opencode-plugin-package";
import type { CapabilityPlugin, LaunchPreflightContext, SetupContext } from "../plugin";
import { pruneEmptyAncestors } from "../utils";

type Config = Record<string, unknown>;
interface ContextModePluginDeps {
  installPackage?: typeof installContextModePackage;
  validatePackage?: typeof validateContextModePackage;
  warmOpenCodePackage?: typeof warmOpenCodePackageCache;
}
interface OwnershipState {
  opencodeConfigs: string[];
}

export const CONTEXT_MODE_OPENCODE_GUIDANCE = `## Context Mode

Use Context Mode tools for commands or tool calls whose output may be large, for sandboxed analysis of large files or structured data, and when indexing large fetched content.

Canonical Mate policy and any more specific tool-routing instructions remain authoritative. In particular, follow explicit requirements to use TokenSave for codebase exploration, Context7 for library documentation, and specialized tools for their assigned operations; Context Mode complements rather than replaces them.`;

function getOwnershipPath(companionPath: string): string {
  return path.join(companionPath, ".mate", "state", "context-mode.json");
}

async function readOwnership(companionPath: string): Promise<OwnershipState> {
  try {
    return JSON.parse(await fs.readFile(getOwnershipPath(companionPath), "utf8")) as OwnershipState;
  } catch {
    return { opencodeConfigs: [] };
  }
}

async function writeOwnership(companionPath: string, state: OwnershipState): Promise<void> {
  const statePath = getOwnershipPath(companionPath);
  if (state.opencodeConfigs.length === 0) {
    await fs.rm(statePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function isRecord(value: unknown): value is Config {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readConfig(filePath: string): Promise<Config> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasContextModeMcp(config: Config): boolean {
  const servers = isRecord(config.mcpServers)
    ? config.mcpServers
    : isRecord(config.mcp)
      ? config.mcp
      : {};
  return Object.entries(servers).some(
    ([name, value]) =>
      name.toLowerCase().includes("context-mode") || JSON.stringify(value).includes("context-mode"),
  );
}

async function assertNoMcpConflict(ctx: SetupContext, provider: "claude" | "opencode") {
  const configPath =
    provider === "claude"
      ? path.join(ctx.companionPath, ".mcp.json")
      : path.join(ctx.companionPath, ".opencode", "opencode.json");
  if (hasContextModeMcp(await readConfig(configPath))) {
    throw new Error(
      `Cannot enable context-mode for ${provider}: ${configPath} already contains a context-mode MCP registration. Remove the duplicate registration or deselect the context-mode capability; Mate did not modify it.`,
    );
  }
}

async function updateOpenCodeConfig(ctx: SetupContext, enabled: boolean): Promise<void> {
  const reference = getContextModePackageReference();
  const ownership = await readOwnership(ctx.companionPath);
  for (const name of ["opencode.json", "tui.json"]) {
    const configPath = path.join(ctx.companionPath, ".opencode", name);
    const owned = ownership.opencodeConfigs.includes(name);
    if (!enabled && !owned) continue;
    const config = await readConfig(configPath);
    const plugins = Array.isArray(config.plugin) ? config.plugin : [];
    const contextModeReferences = plugins.filter(isContextModePackageReference);
    if (enabled && contextModeReferences.some((entry) => entry !== reference)) {
      throw new Error(
        `Cannot enable ${reference}: ${configPath} contains user-owned context-mode reference ${contextModeReferences.join(", ")}. Mate did not modify it.`,
      );
    }
    const preserved = plugins.filter((entry) => !(entry === reference && owned));
    if (enabled) {
      if (!contextModeReferences.includes(reference)) {
        config.plugin = [...plugins, reference];
        ownership.opencodeConfigs.push(name);
      }
    } else if (preserved.length > 0) {
      config.plugin = preserved;
    } else {
      delete config.plugin;
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
  if (!enabled) ownership.opencodeConfigs = [];
  await writeOwnership(ctx.companionPath, ownership);
}

async function validateOpenCodeReferences(ctx: LaunchPreflightContext): Promise<string[]> {
  const expected = getContextModePackageReference();
  const diagnostics: string[] = [];
  for (const name of ["opencode.json", "tui.json"]) {
    const configPath = path.join(ctx.companionPath, ".opencode", name);
    const config = await readConfig(configPath);
    const plugins = Array.isArray(config.plugin) ? config.plugin : [];
    if (!plugins.includes(expected)) {
      diagnostics.push(
        `Missing or stale context-mode package reference in ${configPath}; expected ${expected}.`,
      );
    }
  }
  return diagnostics;
}

export function createContextModePlugin(deps: ContextModePluginDeps = {}): CapabilityPlugin {
  const installPackage = deps.installPackage ?? installContextModePackage;
  const validatePackage = deps.validatePackage ?? validateContextModePackage;
  const warmOpenCodePackage = deps.warmOpenCodePackage ?? warmOpenCodePackageCache;
  return {
    id: "context-mode",
    kind: "capability",
    label: "Context Mode",
    description: "Protect context windows with pinned native Claude and OpenCode plugins.",
    defaultSelected: false,
    isEnabled: (config) =>
      (config.capabilities ?? []).some((capability) => capability.name === "context-mode"),
    async apply(ctx) {
      if (ctx.mode === "setup") {
        await installPackage(ctx.companionPath);
      } else {
        await validatePackage(ctx.companionPath);
      }
      await ctx.instructions?.append(CONTEXT_MODE_OPENCODE_GUIDANCE, {
        providers: ["opencode"],
      });
    },
    async teardown(ctx) {
      await fs.rm(getContextModeInstallDir(ctx.companionPath), { recursive: true, force: true });
      await pruneEmptyAncestors(getContextModeInstallDir(ctx.companionPath), ctx.companionPath);
    },
    forProvider: {
      claude: {
        async apply(ctx) {
          await assertNoMcpConflict(ctx, "claude");
        },
        async teardown() {},
      },
      opencode: {
        preflight: validateOpenCodeReferences,
        async apply(ctx) {
          await assertNoMcpConflict(ctx, "opencode");
          await updateOpenCodeConfig(ctx, true);
          if (ctx.mode === "setup") {
            const result = await warmOpenCodePackage(
              CONTEXT_MODE_PACKAGE_NAME,
              getContextModePackageReference(),
            );
            if (!result.ok) {
              process.stderr.write(
                `mate: could not pre-fetch ${getContextModePackageReference()} for OpenCode: ${result.detail ?? "unknown error"}\n`,
              );
            }
          }
        },
        async teardown(ctx) {
          await updateOpenCodeConfig(ctx, false);
        },
      },
    },
  };
}
