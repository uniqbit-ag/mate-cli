import { FrameworkLauncher } from "../../../lib/orchestrator/launcher";
import {
  LaunchPreflightError,
  RepositoryNotSelectedError,
  ToolNotAllowedError,
} from "../../../lib/orchestrator/types";
import { createStartupProgress } from "../../../lib/components/startup-progress";
import { ensureUnambiguousCompanion, launchAmbiguityDeps } from "../shared/companion-selection";
import { runIndexCapCommand } from "../cap/index-cmd";
import { confirm } from "../../confirm";
import type { LaunchTarget } from "../../launch-selector";

const STEP_LABELS = {
  sync: "Syncing mate",
  graphify: "Indexing graphify",
  tokensave: "Indexing tokensave",
} as const;

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
    process.stderr.write(`mate: unknown launch option: ${arg}\n`);
    process.exitCode = 1;
    return null;
  }

  const skipGit = agentArgs.includes("--no-git");
  return {
    agentArgs: agentArgs.filter((arg) => arg !== "--no-git"),
    ...(skipGit ? { skipGit: true } : {}),
  };
}

/**
 * @description Shared launch execution used by `mate claude`, `mate opencode`,
 * and the direct `mate claude` / `mate opencode` commands: resolves the launch via {@link FrameworkLauncher.prepare},
 * optionally confirms with the user, re-syncs capability indexes via
 * `runIndexCapCommand`, then executes and prints the JSON result.
 * @remarks Exits non-zero with a targeted message for `ToolNotAllowedError`
 * (repo policy disallows this tool) and `RepositoryNotSelectedError` (no
 * active repo — points the user at `mate companion link`); other errors propagate.
 */
export async function runLaunchToolCommand(
  tool: LaunchTarget,
  args: string[],
  options: {
    skipConfirmation?: boolean;
    skipGit?: boolean;
  } = {},
): Promise<void> {
  const showProgress = !!(process.stdout.isTTY && process.stdin.isTTY);
  const progress = showProgress ? createStartupProgress(`Starting ${tool}`) : undefined;

  try {
    progress?.start("sync", STEP_LABELS.sync);
    const prepared = await new FrameworkLauncher().prepare({
      tool,
      args,
      skipGit: options.skipGit,
    });
    progress?.succeed("sync");
    // Stop the Ink UI before running index steps: they spawn graphify/tokensave
    // with stdio "inherit", which writes straight to the terminal and desyncs
    // Ink's line tracking, corrupting later re-renders (e.g. duplicated title).
    progress?.stop();

    if (!options.skipConfirmation) {
      const ok = await confirm("Continue? [y/N] ");
      if (!ok) {
        process.stderr.write("Aborted.\n");
        process.exit(1);
      }
    }

    await runIndexCapCommand([], {
      onStepStart: (step) => process.stdout.write(`${STEP_LABELS[step]}...\n`),
      onStepDone: (step, ok) => process.stdout.write(`${ok ? "✓" : "✗"} ${STEP_LABELS[step]}\n`),
    });

    const result = await prepared.execute();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    progress?.failCurrent();
    progress?.stop();

    if (error instanceof ToolNotAllowedError) {
      process.stderr.write(`mate: \`${tool}\` is disallowed by active repository policy.\n`);
      process.exitCode = 1;
      return;
    }

    if (error instanceof RepositoryNotSelectedError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write("Run `mate companion link` first.\n");
      process.exitCode = 1;
      return;
    }

    if (error instanceof LaunchPreflightError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    throw error;
  }
}
