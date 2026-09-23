import { describe, expect, test } from "bun:test";

import { CONTEXT7_MCP_COMMAND, CONTEXT7_MCP_VERSION, createContext7Plugin } from "./context7";

function requirementFor(onPath: boolean, installs: string[] = []) {
  const plugin = createContext7Plugin({
    isCommandOnPath: (command) => onPath && command === CONTEXT7_MCP_COMMAND,
    install: async () => {
      installs.push("installed");
    },
  });
  const [requirement] = plugin.getInstallRequirements!({ config: {} as never });
  return requirement!;
}

describe("the context7 install requirement", () => {
  test("is satisfied by the binary on PATH, without an install", async () => {
    const installs: string[] = [];
    const requirement = requirementFor(true, installs);
    expect(await requirement.detect()).toBe(true);
    expect(installs).toEqual([]);
  });

  test("is unsatisfied without the binary, and installs the pinned version", async () => {
    const installs: string[] = [];
    const requirement = requirementFor(false, installs);
    expect(await requirement.detect()).toBe(false);
    expect(requirement.command).toBe(
      `npm install -g @upstash/context7-mcp@${CONTEXT7_MCP_VERSION}`,
    );
    await requirement.install();
    expect(installs).toEqual(["installed"]);
  });

  test("never names a moving version", () => {
    expect(CONTEXT7_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(requirementFor(false).command).not.toContain("@latest");
  });
});
