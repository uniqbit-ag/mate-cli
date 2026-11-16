import { FRICTION_CAPABILITY } from "../../../runtime/friction-recorder";
import type { CapabilityPlugin } from "../plugin";

/**
 * Records Mate's own refusals and failed agent-run commands in the
 * machine-local Friction Log. Installs nothing: the guard hooks and the CLI
 * read the selection at the moment something fails.
 */
export function createFrictionPlugin(): CapabilityPlugin {
  return {
    id: FRICTION_CAPABILITY,
    kind: "capability",
    label: "Friction",
    description:
      "Record Mate's refusals and failed commands in agent sessions, on this machine only.",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === FRICTION_CAPABILITY),
    async apply() {},
    async teardown() {},
    cliCommands: [
      {
        name: "list",
        description: "List recorded friction, grouped by fingerprint [--days N] [--json]",
        run: async (argv) =>
          (await import("../../../cli/commands/cap/friction")).runFrictionListCommand(argv),
      },
    ],
  };
}
