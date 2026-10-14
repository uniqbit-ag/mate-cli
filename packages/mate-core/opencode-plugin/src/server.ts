import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
  registerCompanionHooks,
  repositoryWrappedForOpenCode,
} from "../../src/opencode/companion-hooks";
import { readContext } from "../../src/opencode/companion-policy";
import { registerSessionPrepare } from "../../src/opencode/session-prepare";
import { hasLaunchEnvironment } from "../../src/runtime/env";
import { spawnPrepareRunner } from "../../src/runtime/session-prepare-runner";
import { readWrapStateSync } from "../../src/runtime/wrap-state";

import { registerCompanionAccess } from "./add-dir";
import {
  readTrustedAudienceLayer,
  readWrappedAudienceLayer,
  registerAudienceLayer,
} from "./audience-layer";
import { missingRuntimeDirectoryMessage, registerCompanion, resolveMateBin } from "./companion";
import { pluginLaunchEnvironment, type LaunchEnvironment } from "./launch-environment";

/**
 * Only a location in a repository wrapped for OpenCode prepares, and only
 * without a launch environment: `mate opencode` has already prepared the
 * session it starts.
 */
async function registerPrepare(api: Context, companionPath: string, env: LaunchEnvironment) {
  if (hasLaunchEnvironment(env)) return undefined;
  const repoRoot = repositoryWrappedForOpenCode(api.location.directory);
  if (!repoRoot) return undefined;
  const mateBin = resolveMateBin();
  if (!mateBin) {
    console.error(`mate: ${missingRuntimeDirectoryMessage()}`);
    return undefined;
  }
  return registerSessionPrepare(api, {
    directory: api.location.directory,
    repoPath: repoRoot,
    companionPath,
    mateServers: readWrapStateSync(repoRoot).openCodeMcpServers,
    run: spawnPrepareRunner(mateBin, repoRoot),
  });
}

/**
 * Mate OpenCode server plugin (OpenCode 2.x). Loaded through the package's
 * `./server` export; stays inert when no companion resolves from the launch
 * environment or a Projection Root above the session directory. The launch
 * environment is decided once here: outside a managed launch every reader
 * gets `{}`, so an environment inherited by the shared service never counts.
 */
export const MateOpenCodePlugin = Plugin.define({
  id: "mate-opencode-plugin",
  async setup(api) {
    const env = pluginLaunchEnvironment(process.env, process.argv);
    const context = readContext(env, api.location.directory);
    if (!context.companionPath) return;

    /**
     * A layer comes from a payload this launch trusts, else from the wrap of
     * the session's checkout; an inherited environment never names one.
     */
    const layer =
      (await readTrustedAudienceLayer(env)) ??
      (await readWrappedAudienceLayer(api.location.directory, context.companionPath));
    await registerCompanionAccess(api, context.companionPath, layer ? [layer.root] : []);
    await registerCompanionHooks(api, context, env);
    await registerCompanion(api, context, env, layer?.contents.guidance);
    if (layer) await registerAudienceLayer(api, layer.contents);
    /** Last: the guardrails above are live while the local phase holds `setup`. */
    const prepareCleanup = await registerPrepare(api, context.companionPath, env);
    return async () => {
      await prepareCleanup?.();
    };
  },
});

export default MateOpenCodePlugin;
