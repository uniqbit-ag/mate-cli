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
import type {
  CapabilityPlugin,
  LaunchPreflightContext,
  RuntimeContributionsByRuntime,
  SetupContext,
} from "../plugin";
import { readClaudeMcpConfig } from "../providers/claude-format";
import { getOpenCodePluginReferences, readOpenCodeConfig } from "../providers/opencode-format";
import { pruneEmptyAncestors } from "../utils";

interface ContextModePluginDeps {
  installPackage?: typeof installContextModePackage;
  validatePackage?: typeof validateContextModePackage;
  warmOpenCodePackage?: typeof warmOpenCodePackageCache;
}

export const CONTEXT_MODE_OPENCODE_GUIDANCE = `## Context Mode

Use Context Mode tools for commands or tool calls whose output may be large, for sandboxed analysis of large files or structured data, and when indexing large fetched content.

Canonical Mate policy and any more specific tool-routing instructions remain authoritative. In particular, follow explicit requirements to use TokenSave for codebase exploration, Context7 for library documentation, and specialized tools for their assigned operations; Context Mode complements rather than replaces them.`;

// Legacy ownership sidecar from before the managed-marker scheme; removed on
// sight (managed identity is `isContextModePackageReference` now).
function getLegacyOwnershipPath(companionPath: string): string {
  return path.join(companionPath, ".mate", "state", "context-mode.json");
}

// Legacy install location from before the relocate-distribution-deps-to-plugins-local
// change; self-heals on every apply the same way the ownership sidecar above does.
function getLegacyInstallDir(companionPath: string): string {
  return path.join(companionPath, ".mate", "dependencies", CONTEXT_MODE_PACKAGE_NAME);
}

function hasContextModeMcp(servers: Record<string, unknown>): boolean {
  return Object.entries(servers).some(
    ([name, value]) =>
      name.toLowerCase().includes("context-mode") || JSON.stringify(value).includes("context-mode"),
  );
}

async function assertNoMcpConflict(ctx: SetupContext, provider: "claude" | "opencode") {
  const servers =
    provider === "claude"
      ? ((await readClaudeMcpConfig(path.join(ctx.companionPath, ".mcp.json"))).config.mcpServers ??
        {})
      : (((await readOpenCodeConfig(path.join(ctx.companionPath, ".opencode", "opencode.json")))
          .config.mcp as Record<string, unknown>) ?? {});
  const configPath =
    provider === "claude"
      ? path.join(ctx.companionPath, ".mcp.json")
      : path.join(ctx.companionPath, ".opencode", "opencode.json");
  if (hasContextModeMcp(servers)) {
    throw new Error(
      `Cannot enable context-mode for ${provider}: ${configPath} already contains a context-mode MCP registration. Remove the duplicate registration or deselect the context-mode capability; Mate did not modify it.`,
    );
  }
}

async function validateOpenCodeReferences(ctx: LaunchPreflightContext): Promise<string[]> {
  const expected = getContextModePackageReference();
  const diagnostics: string[] = [];
  for (const name of ["opencode.json", "tui.json"]) {
    const configPath = path.join(ctx.companionPath, ".opencode", name);
    const { config } = await readOpenCodeConfig(configPath);
    if (!getOpenCodePluginReferences(config).includes(expected)) {
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
    // The pinned OpenCode plugin reference is declared and reconciled by the
    // OpenCode Runtime Surface into both config files. Any context-mode
    // reference counts as Mate-managed (marker scheme), so stale pins are
    // replaced and teardown removes only context-mode entries.
    getRuntimeContributions(): RuntimeContributionsByRuntime {
      return {
        claude: {
          // The context-mode Claude plugin exposes its skill and MCP tools
          // under the plugin namespace; pre-seed both so routine routing
          // doesn't prompt.
          permissionEntries: [
            "Skill(context-mode:context-mode)",
            "mcp__plugin_context-mode_context-mode__*",
          ],
        },
        opencode: {
          pluginReferences: [
            {
              reference: getContextModePackageReference(),
              isManagedReference: isContextModePackageReference,
              configFiles: ["opencode.json", "tui.json"],
            },
          ],
        },
      };
    },
    async apply(ctx) {
      const legacyInstallDir = getLegacyInstallDir(ctx.companionPath);
      await fs.rm(legacyInstallDir, { recursive: true, force: true });
      await pruneEmptyAncestors(path.dirname(legacyInstallDir), ctx.companionPath);
      if (ctx.mode === "setup") {
        await installPackage(ctx.companionPath);
      } else {
        await validatePackage(ctx.companionPath);
      }
      await ctx.instructions?.append(CONTEXT_MODE_OPENCODE_GUIDANCE, {
        providers: ["opencode"],
      });
      await fs.rm(getLegacyOwnershipPath(ctx.companionPath), { force: true });
    },
    async teardown(ctx) {
      await fs.rm(getContextModeInstallDir(ctx.companionPath), { recursive: true, force: true });
      await pruneEmptyAncestors(getContextModeInstallDir(ctx.companionPath), ctx.companionPath);
      await fs.rm(getLegacyOwnershipPath(ctx.companionPath), { force: true });
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
        async teardown() {},
      },
    },
  };
}
