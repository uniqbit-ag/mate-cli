// A strict external plugin, typechecked by `src/plugin-api.test.ts`.
import type { CapabilityPlugin, CreatePlugin } from "@uniqbit/mate-core/plugin-api";

const createPlugin: CreatePlugin = (_config, host) => {
  const capability: CapabilityPlugin = {
    id: "acme",
    kind: "capability",
    label: "Acme",
    description: "Acme hooks",
    defaultSelected: false,
    isEnabled: () => true,
    async apply() {},
    async teardown() {},
    cliCommands: [
      {
        name: "check",
        description: "Checks acme",
        async run() {
          await host.ensureCapabilityEnabled("acme");
        },
      },
    ],
    getRuntimeContributions: () => ({
      claude: {
        hookMarkers: ["acme-legacy-hook"],
        hookGroups: [
          {
            event: "PostToolUse",
            marker: "acme-hook",
            group: {
              matcher: "Bash",
              hooks: [{ type: "command", command: "acme-hook run", if: "Bash(git *)" }],
            },
          },
        ],
      },
    }),
  };
  return capability;
};

export default createPlugin;
