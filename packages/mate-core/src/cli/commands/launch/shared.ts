import { spawn } from "node:child_process";

import { FRAMEWORK_NAME } from "../../../framework";
import { findRepoLocalRegistryFile } from "../../../lib/orchestrator/repo-local-registry";
import { ensureUnambiguousCompanion, launchAmbiguityDeps } from "../shared/companion-selection";
import { runSyncCommand } from "../sync";
import type { LaunchTarget } from "../../launch-selector";

export interface ParsedLaunchArgs {
  agentArgs: string[];
  skipGit?: boolean;
}

export { ensureUnambiguousCompanion, launchAmbiguityDeps };

export function parseDirectLaunchArgs(argv: string[]): ParsedLaunchArgs {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex < 0) return { agentArgs: argv };

  const beforeSeparator = argv.slice(0, separatorIndex);
  const afterSeparator = argv.slice(separatorIndex + 1);
  const skipGit = afterSeparator.includes("--no-git");
  return {
    agentArgs: [...beforeSeparator, ...afterSeparator.filter((arg) => arg !== "--no-git")],
    ...(skipGit ? { skipGit: true } : {}),
  };
}

export function parseLaunchArgs(argv: string[]): ParsedLaunchArgs | null {
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const agentArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];

  for (const arg of optionArgs) {
    process.stderr.write(`${FRAMEWORK_NAME}: unknown launch option: ${arg}\n`);
    process.exitCode = 1;
    return null;
  }

  const skipGit = agentArgs.includes("--no-git");
  return {
    agentArgs: agentArgs.filter((arg) => arg !== "--no-git"),
    ...(skipGit ? { skipGit: true } : {}),
  };
}

/** Injectable seams for the shim tests. */
export const launchShimDeps = {
  runSyncCommand,
  spawn,
};

/**
 * DEPRECATED shim: `mate <tool>` runs the working-type `mate sync` in the
 * foreground and then spawns the plain agent binary with inherited env, no
 * Mate-injected CLI flags, and no launch environment variables — the session
 * is identical to one started directly (materialized settings + globally
 * registered plugins are the only injection path). Sync repair findings are
 * reported but never block the spawn; sessions surface them as in-session
 * warnings. Removal is planned for a later major.
 */
export function makeLaunchCommand(tool: LaunchTarget) {
  return async function runLaunchCommand(
    args: string[],
    options: { directPassthrough?: boolean } = {},
  ): Promise<void> {
    const parsed = options.directPassthrough ? parseDirectLaunchArgs(args) : parseLaunchArgs(args);
    if (!parsed) return;

    if (!(await ensureUnambiguousCompanion())) {
      process.exitCode = 1;
      return;
    }

    process.stderr.write(
      `${FRAMEWORK_NAME}: \`${FRAMEWORK_NAME} ${tool}\` is deprecated — start \`${tool}\` directly; Mate activates automatically in linked repositories. This shim will be removed in a later major.\n`,
    );

    await launchShimDeps.runSyncCommand(parsed.skipGit ? ["--no-git"] : []);
    // Sync repairs must not block the session (they surface in-session).
    process.exitCode = 0;

    const found = await findRepoLocalRegistryFile(process.cwd());
    const cwd = found?.repoRoot ?? process.cwd();

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = launchShimDeps.spawn(tool, parsed.agentArgs, {
        cwd,
        stdio: "inherit",
        env: process.env,
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    process.exitCode = exitCode;
  };
}
