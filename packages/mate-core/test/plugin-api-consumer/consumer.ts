// A strict external plugin, typechecked by `src/plugin-api.test.ts`.
import type {
  CapabilityPlugin,
  CreatePlugin,
  PluginLifecycle,
  PluginService,
  StudioServiceHost,
} from "@uniqbit/mate-core/plugin-api";

const identity = {
  id: "acme",
  kind: "capability",
  label: "Acme",
  description: "Acme hooks",
  defaultSelected: false,
  isEnabled: () => true,
} as const;

// @ts-expect-error a plugin must declare `lifecycle`
export const withoutLifecycle: CapabilityPlugin = { ...identity };

export const hubWithoutTeardown: CapabilityPlugin = {
  ...identity,
  // @ts-expect-error a declared scope needs both handlers
  lifecycle: { hub: { async apply() {} } },
};

const companion: PluginLifecycle = { async apply() {}, async teardown() {} };

const createPlugin: CreatePlugin = (_config, host) => {
  const capability: CapabilityPlugin = {
    ...identity,
    lifecycle: { companion },
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

/** A service plugin: own command, daemon connection, Studio route, view and terminal sessions. */
export const createServicePlugin: CreatePlugin = () => {
  const service: PluginService = {
    apiVersion: 1,
    id: "acme-service",
    label: "Acme service",
    command: { name: "acme", usage: ["acme serve"], async run() {} },
    connection: (env) => (env.ACME_SOCKET ? { kind: "socket", path: env.ACME_SOCKET } : null),
    studio: (host: StudioServiceHost) => ({
      routes: [
        {
          path: "/status",
          methods: { GET: { kind: "read" }, PUT: { kind: "write", writable: "needs --writable" } },
          handle: async (_request, context) =>
            Response.json({ path: context.path, connected: host.connection !== null }),
        },
      ],
      views: [{ id: "board", label: "Board", module: { dir: "/opt/acme/dist", entry: "view.js" } }],
      worksetSessions: { resolve: async () => ({ reason: "not here" }) },
    }),
  };
  return {
    id: "acme-service",
    kind: "integration",
    label: "Acme service",
    description: "Runs the acme daemon",
    defaultSelected: false,
    isEnabled: () => true,
    lifecycle: {},
    service,
  };
};
