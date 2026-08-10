import { makeLaunchCommand } from "./shared";

/**
 * @command mate claude [-- ...agentArgs]
 * @description DEPRECATED shim: runs the working-type `mate sync` in the
 * foreground, prints a deprecation warning pointing at starting `claude`
 * directly, and spawns the plain `claude` binary with no Mate-injected flags
 * or launch environment variables.
 * @flags
 * - `-- <args>` — arguments forwarded to the launched `claude` process.
 * - `-- --no-git` — skip companion Git synchronization for this launch.
 */
export const runLaunchClaudeCommand = makeLaunchCommand("claude");
