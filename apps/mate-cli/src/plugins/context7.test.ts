import { describe, expect, test } from "bun:test";

import { CONTEXT7_MCP_COMMAND, CONTEXT7_MCP_VERSION, createContext7Plugin } from "./context7";

async function registrationFor(plugin: ReturnType<typeof createContext7Plugin>) {
  const registrations: Array<{ name: string; command?: string; args?: string[] }> = [];
  await plugin.apply?.({
    mcp: {
      register: async (server: { name: string; command?: string; args?: string[] }) => {
        registrations.push(server);
      },
    },
  } as never);
  return registrations;
}

describe("the context7 capability", () => {
  test("registers the latest package through npx on a workstation", async () => {
    const plugin = createContext7Plugin({ mode: "workstation", platform: "darwin" });

    expect(plugin.getInstallRequirements?.({ config: {} as never })).toEqual([]);
    expect(await registrationFor(plugin)).toEqual([
      {
        name: "context7",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    ]);
  });

  test("uses the preinstalled command without package-manager arguments", async () => {
    expect(await registrationFor(createContext7Plugin({ mode: "preinstalled" }))).toEqual([
      { name: "context7", command: CONTEXT7_MCP_COMMAND, args: [] },
    ]);
  });

  test("uses npm's Windows npx command shim", async () => {
    expect(
      await registrationFor(createContext7Plugin({ mode: "workstation", platform: "win32" })),
    ).toEqual([
      {
        name: "context7",
        command: "npx.cmd",
        args: ["-y", "@upstash/context7-mcp"],
      },
    ]);
  });

  test("keeps the appliance image version exact", () => {
    expect(CONTEXT7_MCP_VERSION).toBe("4.1.1");
  });
});
