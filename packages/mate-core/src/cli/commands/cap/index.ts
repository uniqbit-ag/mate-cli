import { runGraphifyCapCommand } from "./graphify";
import { runHeadroomCapCommand } from "./headroom";
import { runOpenspecCapCommand } from "./openspec";
import { runIndexCapCommand } from "./index-cmd";
import { runPluginCliCommand } from "../../plugin-commands";

/**
 * @command mate cap <capability> [...args]
 * @description Dispatches to a capability-scoped subcommand: `graphify`,
 * `headroom`, `openspec` (each forwards `[...args]` to the underlying CLI tool,
 * scoped to the resolved companion/working repo), or `index` (re-syncs
 * capability indexes such as tokensave/graphify after code changes; `sync` is
 * accepted as a compatibility alias for `index`). Names not claimed by the
 * framework dispatch to plugin-declared CLI commands as
 * `mate cap <namespace> <command>`. Prints usage and sets a non-zero exit code
 * when no capability name or an unknown one is given.
 */
export async function runCapCommand(
  capabilityName: string | undefined,
  args: string[],
): Promise<void> {
  if (!capabilityName) {
    process.stderr.write(
      "mate: capability name required. Use `mate cap <openspec|graphify|headroom|index|sync>`.\n",
    );
    process.exitCode = 1;
    return;
  }

  switch (capabilityName) {
    case "graphify":
      await runGraphifyCapCommand(args);
      return;
    case "headroom":
      await runHeadroomCapCommand(args);
      return;
    case "openspec":
      await runOpenspecCapCommand(args);
      return;
    case "index":
    case "sync":
      await runIndexCapCommand(args);
      return;
    default:
      if (await runPluginCliCommand(capabilityName, args[0], args.slice(1))) return;
      process.stderr.write(`mate: unknown capability command: ${capabilityName}\n`);
      process.exitCode = 1;
  }
}
