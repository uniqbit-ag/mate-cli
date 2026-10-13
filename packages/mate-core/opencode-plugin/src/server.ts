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
import { missingRuntimeDirectoryMessage, registerCompanion, resolveMateBin } from "./companion";

/**
 * Only a location in a repository wrapped for OpenCode prepares, and only
 * without a launch environment: `mate opencode` has already prepared the
 * session it starts.
 */
async function registerPrepare(api: Context, companionPath: string) {
  if (hasLaunchEnvironment(process.env)) return undefined;
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
    /** Last: the guardrails above are live while the local phase holds `setup`. */
    const prepareCleanup = await registerPrepare(api, context.companionPath);
    return async () => {
      await prepareCleanup?.();
      await cleanup?.();
    };
  },
});

export default MateOpenCodePlugin;
