import { Plugin } from "@opencode/plugin";
import { readContext, registerCompanionHooks } from "@uniqbit/mate-core/opencode";

import { registerCompanionAccess } from "./add-dir";
import { registerCompanion } from "./companion";

/**
 * Mate OpenCode server plugin (OpenCode 2.x). Loaded through the package's
 * `./server` export; stays inert when no companion resolves from the launch
 * environment or a Projection Root above the session directory.
 */
export const MateOpenCodePlugin = Plugin.define({
  id: "mate-opencode-plugin",
  async setup(api) {
    const context = readContext(process.env, api.location.directory);
    if (!context.companionPath) return;

    await registerCompanionAccess(api, context.companionPath);
    const cleanup = await registerCompanionHooks(api, context);
    await registerCompanion(api, context);
    return cleanup;
  },
});

export default MateOpenCodePlugin;
