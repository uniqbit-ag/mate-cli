import {
  ensureUnambiguousCompanion,
  parseDirectLaunchArgs,
  parseLaunchArgs,
  runLaunchToolCommand,
} from "./shared";

export async function runLaunchCodexCommand(
  args: string[],
  options: { directPassthrough?: boolean } = {},
): Promise<void> {
  const parsed = options.directPassthrough ? parseDirectLaunchArgs(args) : parseLaunchArgs(args);
  if (!parsed) return;

  if (!(await ensureUnambiguousCompanion())) {
    process.exitCode = 1;
    return;
  }

  await runLaunchToolCommand("codex", parsed.agentArgs, {
    skipConfirmation: !!process.stdin.isTTY,
    skipGit: parsed.skipGit,
  });
}
