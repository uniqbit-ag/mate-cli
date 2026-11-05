import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
  registerCompanionHooks,
  registerTokensaveRouting,
  repositoryWrappedForOpenCode,
} from "../../src/opencode/companion-hooks";
import { registerMateServer } from "../../src/opencode/background-server";
import { readContext } from "../../src/opencode/companion-policy";
import { registerEnterWorktree } from "../../src/opencode/enter-worktree";
import { registerSessionPrepare } from "../../src/opencode/session-prepare";
import { registerOpenCodeSessions } from "../../src/opencode/session-register";
import { hasLaunchEnvironment } from "../../src/runtime/env";
import { guardLaunchEnvironment } from "../../src/runtime/launch-env-guard";
import { spawnPrepareRunner } from "../../src/runtime/session-prepare-runner";
import { readWrapStateSync } from "../../src/runtime/wrap-state";

import { registerCompanionAccess } from "./add-dir";
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
    /** First: drops the server password from `process.env` before any shell can start. */
    const server = await registerMateServer(api);
    const env = { ...pluginLaunchEnvironment(process.env, process.argv) };
    guardLaunchEnvironment(env, api.location.directory);
    const context = readContext(env, api.location.directory);
    if (!context.companionPath) return server ? async () => server.dispose() : undefined;

    await registerCompanionAccess(api, context.companionPath);
    await registerCompanionHooks(api, context, env);
    await registerTokensaveRouting(api);
    await registerCompanion(api, context, env);
    await registerEnterWorktree(api, context);
    const sessionsCleanup = await registerOpenCodeSessions(api).catch(() => undefined);
    if (sessionsCleanup) server?.onStop(() => sessionsCleanup());
    /** Last: the guardrails above are live while the local phase holds `setup`. */
    const prepareCleanup = await registerPrepare(api, context.companionPath, env);
    return async () => {
      server?.dispose();
      /** A Mate OpenCode server's sessions outlive a location; its idle stop ends them. */
      await sessionsCleanup?.({ keepSessions: Boolean(server) });
      await prepareCleanup?.();
    };
  },
});

export default MateOpenCodePlugin;
