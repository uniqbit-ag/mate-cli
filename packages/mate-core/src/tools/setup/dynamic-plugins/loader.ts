import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import type { Plugin, SetupScope } from "../plugin";
import { resolveEffectivePluginConfig } from "./config-resolution";
import {
  createPluginHost,
  SUPPORTED_PLUGIN_API_VERSIONS,
  type CreatePlugin,
  type PluginHost,
} from "./host";
import { audienceInstallCommand } from "./audiences";
import { dynamicPluginsWorkspaceRoot, pluginPackageRoot } from "./paths";

interface PluginManifest {
  mate?: { pluginApiVersion?: unknown };
}

/** `warnings` flag a plugin that loads but is likely half-migrated. */
export type DynamicPluginLoadResult =
  | { ok: true; plugin: Plugin; warnings: string[] }
  | { ok: false; warning: string };

export interface DynamicPluginLoadDeps {
  env?: Record<string, string | undefined>;
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
  host?: PluginHost;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads one declared plugin from the workspace of its origin (`audience`:
 * `null` for a base plugin, else the audience declaring it): installed-presence
 * check, API version gate before import, entry-point resolution via that
 * workspace's own module resolver, dynamic import, factory
 * resolution, effective config, factory invocation. Every failure class
 * returns a single warning instead of throwing, so one broken plugin never
 * takes down the CLI.
 */
export async function loadDynamicPlugin(
  companionPath: string,
  declaration: PluginDeclaration,
  deps: DynamicPluginLoadDeps = {},
  audience: string | null = null,
): Promise<DynamicPluginLoadResult> {
  const name = declaration.package;
  const packageRoot = pluginPackageRoot(companionPath, name, audience);

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as PluginManifest;
  } catch {
    return {
      ok: false,
      warning: `plugin "${name}" is not installed; run \`${audienceInstallCommand(audience)}\`.`,
    };
  }

  // Version negotiation happens before any plugin code executes.
  const declaredVersion = manifest.mate?.pluginApiVersion;
  const supported = SUPPORTED_PLUGIN_API_VERSIONS.join(", ");
  if (declaredVersion === undefined || declaredVersion === null) {
    return {
      ok: false,
      warning: `plugin "${name}" declares no mate.pluginApiVersion, so it requires plugin API version 1; this CLI supports: ${supported}.`,
    };
  }
  if (typeof declaredVersion !== "number") {
    return {
      ok: false,
      warning: `plugin "${name}" declares an invalid mate.pluginApiVersion (${JSON.stringify(declaredVersion)}); expected a number, this CLI supports: ${supported}.`,
    };
  }
  if (!SUPPORTED_PLUGIN_API_VERSIONS.includes(declaredVersion)) {
    return {
      ok: false,
      warning: `plugin "${name}" requires plugin API version ${declaredVersion}; this CLI supports: ${supported}.`,
    };
  }

  const configResult = await resolveEffectivePluginConfig(companionPath, declaration, deps.env);
  if (!configResult.ok) {
    return {
      ok: false,
      warning: `plugin "${name}" references unset environment variable${configResult.missingVariables.length > 1 ? "s" : ""}: ${configResult.missingVariables.join(", ")}.`,
    };
  }

  let entryPath: string;
  try {
    const workspaceRequire = createRequire(
      pathToFileURL(
        path.join(dynamicPluginsWorkspaceRoot(companionPath, audience), "package.json"),
      ),
    );
    entryPath = workspaceRequire.resolve(name);
  } catch (error) {
    return {
      ok: false,
      warning: `plugin "${name}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const importModule =
    deps.importModule ??
    ((specifier: string) => import(specifier) as Promise<Record<string, unknown>>);

  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = await importModule(pathToFileURL(entryPath).href);
  } catch (error) {
    return {
      ok: false,
      warning: `plugin "${name}" could not be imported: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const factory =
    typeof moduleExports.default === "function"
      ? (moduleExports.default as CreatePlugin)
      : typeof moduleExports.createPlugin === "function"
        ? (moduleExports.createPlugin as CreatePlugin)
        : undefined;
  if (!factory) {
    return {
      ok: false,
      warning: `plugin "${name}" has no factory export; expected a default-exported function or a named createPlugin export.`,
    };
  }

  let plugin: Plugin;
  try {
    plugin = factory(configResult.config, deps.host ?? createPluginHost());
  } catch (error) {
    return {
      ok: false,
      warning: `plugin "${name}" rejected its configuration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    return checkPluginShape(name, plugin);
  } catch (error) {
    return {
      ok: false,
      warning: `plugin "${name}" returned an invalid plugin object: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Exhaustive over SetupScope, so a new scope cannot slip past validation.
const SETUP_SCOPES: Record<SetupScope, true> = { companion: true, hub: true };
const V1_MEMBERS = ["apply", "teardown", "applyHub", "teardownHub"];

function checkPluginShape(name: string, plugin: Plugin): DynamicPluginLoadResult {
  if (!isRecord(plugin) || typeof plugin.id !== "string" || plugin.id.length === 0) {
    return {
      ok: false,
      warning: `plugin "${name}" returned an invalid plugin object (missing id).`,
    };
  }
  const lifecycle: unknown = plugin.lifecycle;
  if (!isRecord(lifecycle)) {
    return {
      ok: false,
      warning: `plugin "${name}" returned an invalid plugin object (missing lifecycle record); plugin API version 2 requires one.`,
    };
  }
  const warnings: string[] = [];
  for (const [scope, handlers] of Object.entries(lifecycle)) {
    if (handlers === undefined) continue;
    if (!Object.hasOwn(SETUP_SCOPES, scope)) {
      warnings.push(
        `plugin "${name}" declares unknown lifecycle scope "${scope}"; known scopes: ${Object.keys(SETUP_SCOPES).join(", ")}.`,
      );
      continue;
    }
    if (
      !isRecord(handlers) ||
      typeof handlers.apply !== "function" ||
      typeof handlers.teardown !== "function"
    ) {
      return {
        ok: false,
        warning: `plugin "${name}" returned an invalid plugin object (lifecycle.${scope} needs apply and teardown functions).`,
      };
    }
  }
  const v1Members = V1_MEMBERS.filter((member) => member in plugin);
  if (v1Members.length > 0) {
    warnings.push(
      `plugin "${name}" declares ${v1Members.join(", ")}, which plugin API version 2 ignores; move the handlers into lifecycle.`,
    );
  }
  return { ok: true, plugin, warnings };
}
