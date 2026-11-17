import { FRAMEWORK_NAME } from "../../../framework";
import { REPORT_COSTS, REPORT_KINDS } from "../../../runtime/friction-log";
import { FRICTION_CAPABILITY } from "../../../runtime/friction-recorder";
import type { CapabilityPlugin, RuntimeContributionsByRuntime } from "../plugin";

/** The only trigger for friction that has no event, so it stays short. */
export const FRICTION_GUIDANCE = `## Friction

When ${FRAMEWORK_NAME} gets in your way without a refusal or error to point at, such as a skill step that does not fit or missing guidance, record it when it happens: \`${FRAMEWORK_NAME} cap friction report --kind <${REPORT_KINDS.join("|")}> --subject <type>:<name> --expected "<what you expected>" --evidence "<what you saw>"\`. Record one report per problem, then keep working on your task. When nothing went wrong, record nothing.`;

/**
 * Records Mate's own refusals and failed agent-run commands in the
 * machine-local Friction Log. Installs only its guidance and permission: the guard hooks and the CLI
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
    getRuntimeContributions(): RuntimeContributionsByRuntime {
      const guidanceSections = [{ content: FRICTION_GUIDANCE }];
      return {
        claude: {
          guidanceSections,
          permissionEntries: [`Bash(${FRAMEWORK_NAME} cap friction:*)`],
        },
        opencode: { guidanceSections },
      };
    },
    async apply() {},
    async teardown() {},
    cliCommands: [
      {
        name: "list",
        description: "List recorded friction, grouped by fingerprint [--days N] [--all] [--json]",
        run: async (argv) =>
          (await import("../../../cli/commands/cap/friction")).runFrictionListCommand(argv),
      },
      {
        name: "report",
        description: `Record what you expected [<event-id>] --kind <${REPORT_KINDS.join("|")}> --expected <text> [--cost <${REPORT_COSTS.join("|")}>] [--subject <type>[:<name>]] [--evidence <text>] [--workaround <text>] [--json]`,
        run: async (argv) =>
          (await import("../../../cli/commands/cap/friction")).runFrictionReportCommand(argv),
      },
    ],
  };
}
