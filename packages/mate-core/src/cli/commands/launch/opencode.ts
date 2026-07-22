import { makeLaunchCommand } from "./shared";

/**
 * @command mate opencode [-- ...agentArgs]
 * @description Launches OpenCode for the active working repository. In a
 * TTY, launches directly; outside a TTY, launches via
 * {@link runLaunchToolCommand} with confirmation.
 * @flags
 * - `-- <args>` — arguments forwarded to the launched `opencode` process.
 * - `-- --no-git` — skip companion Git synchronization for this launch.
 * @remarks When invoked via `directPassthrough` (the top-level `mate
 * opencode` alias), all args before `--` are treated as agent args rather
 * than being parsed as launch options.
 */
export const runLaunchOpenCodeCommand = makeLaunchCommand("opencode");
