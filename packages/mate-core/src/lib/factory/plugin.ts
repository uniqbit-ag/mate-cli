import { runFactoryCommand } from "../../cli/commands/factory/factory";
import type { Plugin } from "../../tools/setup/plugin";
import type { PluginService } from "../../tools/setup/service";
import { FACTORY_BROKER_ENV } from "./client";
import { factoryStudio } from "./studio/contribution";
import { FACTORY_SERVICE_ID } from "./studio/routes";

/** `mate help` lines of the factory's command. */
export const FACTORY_COMMAND_USAGE = [
  "factory serve --socket <path> --docker-host <url> --state-dir <dir> --image <image>",
  "   --user <name> --companions-dir <dir> (the appliance's factory broker, run as root)",
  "factory attach <workset> --session <id> --companion <path> [--start clarify|explore|continue]",
];

/**
 * The factory as a service: `mate factory`, the broker at `MATE_FACTORY_BROKER` and its
 * Studio part. Uses only the service plugin contract, so it can live in its own package.
 */
export function createFactoryService(): PluginService {
  return {
    apiVersion: 1,
    id: FACTORY_SERVICE_ID,
    label: "Factory",
    command: {
      name: "factory",
      usage: FACTORY_COMMAND_USAGE,
      run: ([subcommand, ...argv]) => runFactoryCommand(subcommand, argv),
    },
    connection: (env) => {
      const socket = env[FACTORY_BROKER_ENV];
      return socket ? { kind: "socket", path: socket } : null;
    },
    studio: (host) => factoryStudio(host),
  };
}

/** The factory plugin a distribution registers; adds nothing to agent sessions. */
export function createFactoryPlugin(): Plugin {
  return {
    id: FACTORY_SERVICE_ID,
    kind: "integration",
    label: "Factory",
    description: "Runs agent Worksets in isolated containers, driven from Studio.",
    defaultSelected: false,
    selectable: false,
    isEnabled: () => false,
    async apply() {},
    async teardown() {},
    service: createFactoryService(),
  };
}
