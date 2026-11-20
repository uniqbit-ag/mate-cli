import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import type { Plugin } from "./plugin";
import type { PluginService, ServiceCommand } from "./service";

/** Service API version this core implements. */
export const SERVICE_API_VERSION = 1;

/** Service API versions this core mounts. */
export const SUPPORTED_SERVICE_API_VERSIONS: readonly number[] = [SERVICE_API_VERSION];

const SERVICE_ID = /^[a-z][a-z0-9-]*$/;

function warnOnStderr(message: string): void {
  process.stderr.write(`${FRAMEWORK_NAME}: ${message}\n`);
}

/**
 * The services of the registered plugins, in registration order. A service with an
 * unsupported API version, an invalid id or an id already taken is left out with a warning.
 */
export function registeredServices(
  plugins: readonly Plugin[] = getActiveDistribution().registry.getAll(),
  warn: (message: string) => void = warnOnStderr,
): PluginService[] {
  const services: PluginService[] = [];
  for (const plugin of plugins) {
    const service = plugin.service;
    if (!service) continue;
    if (!SUPPORTED_SERVICE_API_VERSIONS.includes(service.apiVersion)) {
      warn(
        `plugin "${plugin.id}" declares service API version ${String(service.apiVersion)}; this CLI supports: ${SUPPORTED_SERVICE_API_VERSIONS.join(", ")}. Its service is not mounted.`,
      );
      continue;
    }
    if (typeof service.id !== "string" || !SERVICE_ID.test(service.id)) {
      warn(`plugin "${plugin.id}" declares an invalid service id; its service is not mounted.`);
      continue;
    }
    if (services.some((existing) => existing.id === service.id)) {
      warn(
        `plugin "${plugin.id}" declares service "${service.id}", already mounted; first registration wins.`,
      );
      continue;
    }
    services.push(service);
  }
  return services;
}

/** The service command named `name`; built-in commands are dispatched before this is asked. */
export function findServiceCommand(
  name: string | undefined,
  services: readonly PluginService[] = registeredServices(),
): ServiceCommand | undefined {
  if (!name) return undefined;
  return services.find((service) => service.command?.name === name)?.command;
}

/** `mate help` lines of every service command. */
export function serviceCommandLines(
  services: readonly PluginService[] = registeredServices(undefined, () => {}),
): string[] {
  return services.flatMap((service) =>
    (service.command?.usage ?? []).map((line) =>
      line.startsWith(" ") ? line : ` ${FRAMEWORK_NAME} ${line}`,
    ),
  );
}
