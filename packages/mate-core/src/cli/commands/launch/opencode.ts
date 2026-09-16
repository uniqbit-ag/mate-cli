import { makeLaunchCommand } from "./shared";

/**
 * @command mate opencode [-- ...agentArgs]
 * @description Launches OpenCode for the active working repository, or the
 * Companion Repository with `-- --companion`. TTY launches ask for confirmation;
 * non-interactive launches proceed without it.
 * @flags
 * - `-- <args>` — arguments forwarded to the launched `opencode` process.
 * - `-- --no-git` — skip companion Git synchronization for this launch.
 * - `-- --companion` — launch against the Companion Repository without a Working Repository.
 * - `-- --yes` — skip the TTY confirmation.
 * @remarks When invoked via `directPassthrough` (the top-level `mate
 * opencode` alias), all args before `--` are treated as agent args rather
 * than being parsed as launch options.
 */
export const runLaunchOpenCodeCommand = makeLaunchCommand("opencode");
