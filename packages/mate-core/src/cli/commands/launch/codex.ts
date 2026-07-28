import { makeLaunchCommand } from "./shared";

/**
 * @command mate codex [-- ...agentArgs]
 * @description Launches Codex for the active working repository.
 */
export const runLaunchCodexCommand = makeLaunchCommand("codex");
