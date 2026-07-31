import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { getActiveDistribution } from "../../../distribution";
import { FRAMEWORK_NAME } from "../../../framework";
import { CompanionResolver } from "../../../lib/orchestrator/companion-resolver";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { PLUGIN_DECLARATION_POLICIES } from "../../../lib/orchestrator/config-store";
import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import type { PluginRegistry } from "../registry";
import { loadDynamicPlugin, type DynamicPluginLoadDeps } from "./loader";

// Packages already registered in this process; re-hydration (e.g. right after
// an install inside the same run) only picks up plugins that failed before.
const hydratedPackages = new Set<string>();

export function resetDynamicPluginHydration(): void {
  hydratedPackages.clear();
}

export interface HydrateDynamicPluginsDeps extends DynamicPluginLoadDeps {
  cwd?: string;
  /** Explicit companion context; skips quiet resolution. */
  companionPath?: string;
  registry?: PluginRegistry;
  warn?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Quiet variant of companion resolution: never prompts, never errors. An
 * ambiguous or absent companion means hydration is a no-op —
 * `ensureUnambiguousCompanion` later in `main()` stays the authoritative,
 * user-facing resolution.
 */
async function resolveCompanionQuietly(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  const pinned = env.MATE_ARTIFACT_PATH;
  if (pinned) return path.resolve(pinned);
  const resolver = new CompanionResolver(new GlobalConfigStore());
  const resolution = await resolver.resolveWithDiagnostics(path.resolve(cwd));
  if (resolution.ambiguousMatches.length > 1) return null;
  if (resolution.match) return resolution.match.companionPath;
  try {
    // Running inside a companion directory itself.
    await fs.access(path.join(cwd, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"));
    return path.resolve(cwd);
  } catch {
    return null;
  }
}

/**
 * Raw read of the companion's `plugins:` list. Deliberately avoids
 * `ConfigStore.load()` — hydration runs on every invocation and must never
 * create or migrate config files as a side effect.
 */
async function readDeclarations(companionPath: string): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "utf8",
    );
    const parsed = parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) return [];
    return parsed.plugins;
  } catch {
    return [];
  }
}

function validateDeclaration(entry: unknown): { declaration?: PluginDeclaration; error?: string } {
  if (!isRecord(entry) || typeof entry.package !== "string" || typeof entry.version !== "string") {
    return { error: `ignoring malformed plugins entry: ${JSON.stringify(entry)}` };
  }
  const policy = entry.policy;
  if (policy !== undefined && !PLUGIN_DECLARATION_POLICIES.includes(policy as never)) {
    return {
      error: `plugin "${entry.package}": policy "${String(policy)}" is not allowed for declared plugins (allowed: ${PLUGIN_DECLARATION_POLICIES.join(", ")}).`,
    };
  }
  return { declaration: entry as unknown as PluginDeclaration };
}

/**
 * Registers the companion's declared plugins into the active registry —
 * compiled-in plugins first (they are already registered), declared order
 * after. Runs before cap-command detection on every invocation. No-op
 * without a companion or `plugins:` entries; all diagnostics go to stderr;
 * never throws.
 */
export async function hydrateDynamicPlugins(deps: HydrateDynamicPluginsDeps = {}): Promise<void> {
  const warn =
    deps.warn ?? ((message: string) => process.stderr.write(`${FRAMEWORK_NAME}: ${message}\n`));
  try {
    const env = deps.env ?? process.env;
    const companionPath =
      deps.companionPath ?? (await resolveCompanionQuietly(deps.cwd ?? process.cwd(), env));
    if (!companionPath) return;

    const entries = await readDeclarations(companionPath);
    if (entries.length === 0) return;

    const registry = deps.registry ?? getActiveDistribution().registry;

    for (const entry of entries) {
      const { declaration, error } = validateDeclaration(entry);
      if (!declaration) {
        if (error) warn(error);
        continue;
      }
      if (hydratedPackages.has(declaration.package)) continue;

      // oxlint-disable-next-line no-await-in-loop -- declared order is part of the contract
      const result = await loadDynamicPlugin(companionPath, declaration, deps);
      if (!result.ok) {
        warn(result.warning);
        continue;
      }

      const namespace = result.plugin.cliNamespace ?? result.plugin.id;
      const holder = registry
        .getAll()
        .find((existing) => (existing.cliNamespace ?? existing.id) === namespace);
      if (holder) {
        warn(
          `plugin "${declaration.package}" ("${result.plugin.id}") claims cap namespace "${namespace}" already registered by "${holder.id}"; first registration wins.`,
        );
      }

      registry.register({ plugin: result.plugin, policy: declaration.policy ?? "optional" });
      hydratedPackages.add(declaration.package);
    }
  } catch (error) {
    warn(
      `dynamic plugin hydration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
