import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { FRAMEWORK_NAME } from "../../../framework";
import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import type { Plugin } from "../plugin";
import { resolveEffectivePluginConfig } from "./config-resolution";
import {
  createPluginHost,
  SUPPORTED_PLUGIN_API_VERSIONS,
  type CreatePlugin,
  type PluginHost,
} from "./host";
import { dynamicPluginsWorkspaceRoot, pluginPackageRoot } from "./paths";

interface PluginManifest {
  mate?: { pluginApiVersion?: unknown };
}

export type DynamicPluginLoadResult = { ok: true; plugin: Plugin } | { ok: false; warning: string };

export interface DynamicPluginLoadDeps {
  env?: Record<string, string | undefined>;
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
  host?: PluginHost;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads one declared plugin from the shared workspace: installed-presence
 * check, API version gate before import, entry-point resolution via the
 * shared workspace's own module resolver, dynamic import, factory
 * resolution, effective config, factory invocation. Every failure class
 * returns a single warning instead of throwing, so one broken plugin never
 * takes down the CLI.
 */
export async function loadDynamicPlugin(
  companionPath: string,
  declaration: PluginDeclaration,
  deps: DynamicPluginLoadDeps = {},
): Promise<DynamicPluginLoadResult> {
  const name = declaration.package;
  const packageRoot = pluginPackageRoot(companionPath, name);

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as PluginManifest;
  } catch {
    return {
      ok: false,
      warning: `plugin "${name}" is not installed; run \`${FRAMEWORK_NAME} install\`.`,
    };
  }

  // Version negotiation happens before any plugin code executes.
  const apiVersion = manifest.mate?.pluginApiVersion ?? 1;
  if (typeof apiVersion !== "number" || !SUPPORTED_PLUGIN_API_VERSIONS.includes(apiVersion)) {
    return {
      ok: false,
      warning: `plugin "${name}" requires plugin API version ${String(apiVersion)}; this CLI supports: ${SUPPORTED_PLUGIN_API_VERSIONS.join(", ")}.`,
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
      pathToFileURL(path.join(dynamicPluginsWorkspaceRoot(companionPath), "package.json")),
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

  if (!isRecord(plugin) || typeof plugin.id !== "string" || plugin.id.length === 0) {
    return {
      ok: false,
      warning: `plugin "${name}" returned an invalid plugin object (missing id).`,
    };
  }
  return { ok: true, plugin };
}
