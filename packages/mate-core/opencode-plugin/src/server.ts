import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
  registerCompanionHooks,
  repositoryWrappedForOpenCode,
} from "../../src/opencode/companion-hooks";
import { readContext, type CompanionContext } from "../../src/opencode/companion-policy";
import { registerSessionPrepare } from "../../src/opencode/session-prepare";
import { spawnPrepareRunner } from "../../src/runtime/session-prepare-runner";
import { readWrapStateSync } from "../../src/runtime/wrap-state";

import { registerCompanionAccess } from "./add-dir";
import { missingRuntimeDirectoryMessage, registerCompanion, resolveMateBin } from "./companion";
import { pluginLaunchEnvironment } from "./launch-environment";

/**
 * Only a session resolved from a projection of a repository wrapped for
 * OpenCode prepares: `mate opencode` has already prepared the session it starts.
 */
async function registerPrepare(api: Context, context: CompanionContext) {
  const repoRoot = repositoryWrappedForOpenCode(context.session);
  if (!repoRoot) return undefined;
  const mateBin = resolveMateBin();
  if (!mateBin) {
    console.error(`mate: ${missingRuntimeDirectoryMessage()}`);
    return undefined;
  }
  return registerSessionPrepare(api, {
    directory: api.location.directory,
    repoPath: repoRoot,
    companionPath: context.companionPath,
    mateServers: readWrapStateSync(repoRoot).openCodeMcpServers,
    run: spawnPrepareRunner(mateBin, repoRoot),
  });
}

/**
 * Mate OpenCode server plugin (OpenCode 2.x). Loaded through the package's
 * `./server` export; stays inert when Session Resolution answers no companion
 * for the launch environment and the session directory. The launch
 * environment is decided once here: outside a managed launch every reader
 * gets `{}`, so an environment inherited by the shared service never counts.
 */
export const MateOpenCodePlugin = Plugin.define({
  id: "mate-opencode-plugin",
  async setup(api) {
    const env = pluginLaunchEnvironment(process.env, process.argv);
    const context = readContext(env, api.location.directory);
    if (!context.companionPath) return;

    await registerCompanionAccess(api, context.companionPath);
    await registerCompanionHooks(api, context, env);
    await registerCompanion(api, context, env);
    /** Last: the guardrails above are live while the local phase holds `setup`. */
    const prepareCleanup = await registerPrepare(api, context);
    return async () => {
      await prepareCleanup?.();
    };
  },
});

export default MateOpenCodePlugin;
