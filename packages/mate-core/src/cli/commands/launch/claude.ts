import {
  ensureUnambiguousCompanion,
  parseDirectLaunchArgs,
  parseLaunchArgs,
  runLaunchToolCommand,
} from "./shared";

/**
 * @command mate claude [-- ...agentArgs]
 * @description Launches Claude Code for the active working repository. In a
 * TTY, launches directly; outside a TTY, launches via
 * {@link runLaunchToolCommand} with confirmation.
 * @flags
 * - `-- <args>` — arguments forwarded to the launched `claude` process.
 * - `-- --no-git` — skip companion Git synchronization for this launch.
 * @remarks When invoked via `directPassthrough` (the top-level `mate claude`
 * alias), all args before `--` are treated as agent args rather than being
 * parsed as launch options.
 */
export async function runLaunchClaudeCommand(
  args: string[],
  options: { directPassthrough?: boolean } = {},
): Promise<void> {
  const parsed = options.directPassthrough ? parseDirectLaunchArgs(args) : parseLaunchArgs(args);
  if (!parsed) return;

  if (!(await ensureUnambiguousCompanion())) {
    process.exitCode = 1;
    return;
  }

  await runLaunchToolCommand("claude", parsed.agentArgs, {
    skipConfirmation: !!process.stdin.isTTY,
    skipGit: parsed.skipGit,
  });
}
