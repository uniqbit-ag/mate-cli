import { makeLaunchCommand } from "./shared";

/**
 * @command mate claude [-- ...agentArgs]
 * @description Launches Claude Code for the active working repository, or the
 * Companion Repository with `-- --companion`. TTY launches ask for confirmation;
 * non-interactive launches proceed without it.
 * @flags
 * - `-- <args>` — arguments forwarded to the launched `claude` process.
 * - `-- --no-git` — skip companion Git synchronization for this launch.
 * - `-- --companion` — launch against the Companion Repository without a Working Repository.
 * - `-- --yes` — skip the TTY confirmation.
 * @remarks When invoked via `directPassthrough` (the top-level `mate claude`
 * alias), all args before `--` are treated as agent args rather than being
 * parsed as launch options.
 */
export const runLaunchClaudeCommand = makeLaunchCommand("claude");
