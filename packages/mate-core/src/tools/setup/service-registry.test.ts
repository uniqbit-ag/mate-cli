import { describe, expect, it } from "bun:test";

import type { Plugin } from "./plugin";
import type { PluginService } from "./service";
import { findServiceCommand, registeredServices, serviceCommandLines } from "./service-registry";

function plugin(id: string, service?: Partial<PluginService>): Plugin {
  return {
    id,
    kind: "integration",
    label: id,
    description: id,
    defaultSelected: false,
    isEnabled: () => true,
    lifecycle: {},
    ...(service ? { service: { apiVersion: 1, id, label: id, ...service } as PluginService } : {}),
  };
}

describe("registered services", () => {
  it("lists services in registration order and skips plugins without one", () => {
    const services = registeredServices(
      [plugin("beta", {}), plugin("plain"), plugin("acme", {})],
      () => {},
    );
    expect(services.map((service) => service.id)).toEqual(["beta", "acme"]);
  });

  it("leaves out an unsupported API version, an invalid id and a taken id, warning for each", () => {
    const warnings: string[] = [];
    const services = registeredServices(
      [
        plugin("acme", {}),
        plugin("future", { apiVersion: 2 as never }),
        plugin("bad", { id: "Bad Id" }),
        plugin("twin", { id: "acme" }),
      ],
      (message) => warnings.push(message),
    );
    expect(services.map((service) => service.id)).toEqual(["acme"]);
    expect(warnings).toEqual([
      expect.stringContaining("service API version 2"),
      expect.stringContaining("invalid service id"),
      expect.stringContaining("first registration wins"),
    ]);
  });

  it("finds a service command by name and formats its help lines", () => {
    const run = async () => {};
    const services = registeredServices(
      [
        plugin("acme", {
          command: { name: "acme", usage: ["acme serve", "   --socket <path>"], run },
        }),
      ],
      () => {},
    );
    expect(findServiceCommand("acme", services)?.run).toBe(run);
    expect(findServiceCommand("other", services)).toBeUndefined();
    expect(findServiceCommand(undefined, services)).toBeUndefined();
    expect(serviceCommandLines(services)).toEqual([" mate acme serve", "   --socket <path>"]);
  });
});
