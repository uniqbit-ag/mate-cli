// oxlint-disable no-await-in-loop
import { getActiveDistribution } from "../../distribution";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import { validateDeclaration } from "./dynamic-plugins/declarations";
import { loadDynamicPlugin, type DynamicPluginLoadDeps } from "./dynamic-plugins/loader";
import type { PluginRegistry, NormalizedRegistration } from "./registry";

export interface LoadedAudience {
  registrations: NormalizedRegistration[];
  warnings: string[];
}

/**
 * The registrations of one named audience, independent of `MATE_AUDIENCE`: a
 * plugin this process already hydrated is reused, any other is loaded for its
 * declarations only — never activated, no lifecycle hook run. Used where the
 * audience comes from a checkout's wrap rather than the environment.
 */
export async function loadAudienceRegistrations(
  companionPath: string,
  config: FrameworkConfig,
  audience: string,
  registry: PluginRegistry = getActiveDistribution().registry,
  deps: DynamicPluginLoadDeps = {},
): Promise<LoadedAudience> {
  const loaded: LoadedAudience = { registrations: [], warnings: [] };
  const hydrated = registry.getEntries();
  for (const entry of config.audiences?.[audience]?.plugins ?? []) {
    const { declaration, error } = validateDeclaration(entry);
    if (!declaration) {
      if (error) loaded.warnings.push(error);
      continue;
    }
    const known = hydrated.find((candidate) => candidate.packageName === declaration.package);
    if (known) {
      loaded.registrations.push({ ...known, audience });
      continue;
    }
    const result = await loadDynamicPlugin(companionPath, declaration, deps);
    if (!result.ok) {
      loaded.warnings.push(`audience "${audience}": ${result.warning}`);
      continue;
    }
    loaded.registrations.push({
      plugin: result.plugin,
      policy: "required",
      audience,
      packageName: declaration.package,
    });
  }
  return loaded;
}
