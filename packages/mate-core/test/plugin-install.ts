import type { PluginInstallDeps } from "../src/tools/setup/dynamic-plugins/install";

/** Both subprocess boundaries are supplied, so a partial fixture never reaches ambient npm. */
export function fakePluginInstallDeps(overrides: PluginInstallDeps): Required<PluginInstallDeps> {
  return {
    runNpmInstall: overrides.runNpmInstall ?? (async () => ({ ok: true })),
    runNpmUpdate: overrides.runNpmUpdate ?? (async () => ({ ok: true })),
  };
}
