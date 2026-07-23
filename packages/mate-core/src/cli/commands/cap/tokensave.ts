import { spawnSync } from "node:child_process";

import { resolveForLaunch } from "../../../lib/orchestrator/framework-context";
import type { CapabilityConfig } from "../../../lib/orchestrator/types";
import { ensureTokensaveInstalled } from "../../../tools/setup/capabilities/tokensave";

interface TokensaveCapDeps {
  resolveForLaunch?: typeof resolveForLaunch;
  ensureInstalled?: (repoPath: string) => Promise<boolean>;
  spawn?: typeof spawnSync;
}

/**
 * @command mate cap tokensave [...args]
 * @description Forwards `[...args]` to the `tokensave` CLI, run from the
 * active working repository. Requires the `tokensave` capability to be enabled
 * in `.mate/config/framework.yaml` and a registered working repo for the
 * current `MATE_REPO_ID`. Ensures the `tokensave` binary is installed in that
 * repo (via {@link ensureTokensaveInstalled}) before forwarding.
 * @remarks The child process's exit code is propagated via `process.exitCode`.
 */
export async function runTokensaveCapCommand(
  args: string[],
  deps: TokensaveCapDeps = {},
): Promise<void> {
  const resolveLaunch = deps.resolveForLaunch ?? resolveForLaunch;
  const ensureInstalled = deps.ensureInstalled ?? ensureTokensaveInstalled;
  const spawn = deps.spawn ?? spawnSync;

  const { repositoryId, repository, configStore, workingRepoStore } = await resolveLaunch(
    process.cwd(),
  );
  const config = await configStore.load();

  const capability = (config.capabilities ?? []).find(
    (entry: CapabilityConfig) => entry.name === "tokensave",
  );
  if (!capability) {
    process.stderr.write("tokensave capability is not enabled in .mate/config/framework.yaml\n");
    process.exitCode = 1;
    return;
  }

  const repo =
    repository ?? (await workingRepoStore.load()).repos.find((entry) => entry.id === repositoryId);
  if (!repo) {
    process.stderr.write(`mate: no working repo found for id ${repositoryId}\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await ensureInstalled(repo.path))) {
    process.exitCode = 1;
    return;
  }

  const result = spawn("tokensave", args, {
    cwd: repo.path,
    stdio: "inherit",
  });

  if (result.error) {
    process.stderr.write(`Failed to run tokensave: ${result.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.status !== null) {
    process.exitCode = result.status;
  }
}
