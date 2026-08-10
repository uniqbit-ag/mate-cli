import { makeLaunchCommand } from "./shared";

/**
 * @command mate opencode [-- ...agentArgs]
 * @description DEPRECATED shim: runs the working-type `mate sync` in the
 * foreground, prints a deprecation warning pointing at starting `opencode`
 * directly, and spawns the plain `opencode` binary with no Mate-injected
 * flags or launch environment variables.
 * @flags
 * - `-- <args>` — arguments forwarded to the launched `opencode` process.
 * - `-- --no-git` — skip companion Git synchronization for this launch.
 */
export const runLaunchOpenCodeCommand = makeLaunchCommand("opencode");
