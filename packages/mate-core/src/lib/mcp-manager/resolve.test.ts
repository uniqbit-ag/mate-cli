import { describe, expect, test } from "bun:test";

import { resolveMcpServers } from "./resolve";

const servers = {
  "acme-docs": { command: "acme-docs-mcp" },
  "acme-api": { url: "https://mcp.acme.example" },
  "acme-db": { command: "acme-db-mcp" },
};
const groups = { "acme-data": ["acme-api", "acme-db"] };

function config(enabled: unknown, analyst?: unknown) {
  return {
    mcpManager: { servers, groups, enabled },
    ...(analyst ? { audiences: { analyst: { mcpManager: analyst } } } : {}),
  };
}

function names(raw: unknown, audience: string | null): string[] {
  return resolveMcpServers(raw, audience).map((server) => server.name);
}

describe("resolveMcpServers", () => {
  test("base enables standalone servers and group members, ordered by name", () => {
    const raw = config({ servers: ["acme-docs"], groups: ["acme-data"] });
    expect(names(raw, null)).toEqual(["acme-api", "acme-db", "acme-docs"]);
    expect(resolveMcpServers(raw, null)[0]).toEqual({
      name: "acme-api",
      server: servers["acme-api"],
    });
  });

  test("an audience disables a base server", () => {
    const raw = config(
      { servers: ["acme-docs", "acme-db"] },
      { disable: { servers: ["acme-db"] } },
    );
    expect(names(raw, "analyst")).toEqual(["acme-docs"]);
  });

  test("a named server beats a disabled group", () => {
    const raw = config(
      { groups: ["acme-data"] },
      { disable: { groups: ["acme-data"] }, enable: { servers: ["acme-api"] } },
    );
    expect(names(raw, "analyst")).toEqual(["acme-api"]);
  });

  test("an audience enables a group base leaves off", () => {
    const raw = config({ servers: ["acme-docs"] }, { enable: { groups: ["acme-data"] } });
    expect(names(raw, "analyst")).toEqual(["acme-api", "acme-db", "acme-docs"]);
    expect(names(raw, null)).toEqual(["acme-docs"]);
  });

  test("an unknown audience and base apply the base set only", () => {
    const raw = config({ servers: ["acme-docs"] }, { enable: { groups: ["acme-data"] } });
    expect(names(raw, "unknown")).toEqual(["acme-docs"]);
    expect(names(raw, "base")).toEqual(["acme-docs"]);
  });

  test("no mcpManager section gives no servers", () => {
    expect(resolveMcpServers({ allowedAgents: [] }, null)).toEqual([]);
  });
});
