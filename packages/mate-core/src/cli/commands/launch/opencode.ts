import { makeLaunchCommand } from "./shared";

/**
 * @command mate opencode [-- ...agentArgs]
 * @description Launches OpenCode for the active working repository, or the
 * Companion Repository with `-- --companion`, without an interactive confirmation.
 * @flags
 * - `-- <args>` — arguments forwarded to the launched `opencode` process.
 * - `-- --no-git` — skip companion Git synchronization for this launch.
 * - `-- --companion` — launch against the Companion Repository without a Working Repository.
 * - `-- --yes` — accepted as a Mate compatibility no-op; launches are always prompt-free.
 * @remarks When invoked via `directPassthrough` (the top-level `mate
 * opencode` alias), all args before `--` are treated as agent args rather
 * than being parsed as launch options.
 */
export const runLaunchOpenCodeCommand = makeLaunchCommand("opencode");
