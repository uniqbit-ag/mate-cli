import { describe, expect, test } from "bun:test";

import { validateMcpManagerConfig } from "./validate";

const catalog = {
  servers: {
    "acme-docs": { command: "npx", args: ["-y", "acme-docs-mcp"], env: ["ACME_TOKEN"] },
    "acme-api": {
      url: "https://mcp.acme.example",
      transport: "http",
      headers: { Authorization: "Bearer ${ACME_KEY}" },
    },
    "acme-db": { command: "acme-db-mcp", env: ["ACME_DB_URL"] },
  },
  groups: { "acme-data": ["acme-api", "acme-db"] },
  enabled: { servers: ["acme-docs"], groups: ["acme-data"] },
};

function withServer(name: string, server: unknown) {
  return { mcpManager: { servers: { ...catalog.servers, [name]: server } } };
}

function withAudience(selection: unknown) {
  return { mcpManager: catalog, audiences: { analyst: { mcpManager: selection } } };
}

describe("validateMcpManagerConfig", () => {
  test("accepts standalone and grouped servers holding variable names", () => {
    expect(() => validateMcpManagerConfig({ mcpManager: catalog })).not.toThrow();
  });

  test("rejects a server name outside the pattern", () => {
    expect(() => validateMcpManagerConfig(withServer("Acme", { command: "x" }))).toThrow(
      'Invalid MCP server name "Acme"',
    );
  });

  test("rejects a server declaring two transports, naming it and both keys", () => {
    expect(() =>
      validateMcpManagerConfig(withServer("acme-x", { command: "x", url: "https://a.example" })),
    ).toThrow('mcpManager.servers.acme-x declares both "command" and "url"');
  });

  test("rejects a server declaring no transport", () => {
    expect(() => validateMcpManagerConfig(withServer("acme-x", { env: [] }))).toThrow(
      'needs either "command" or "url"',
    );
  });

  test("rejects a group listing an unknown server", () => {
    expect(() =>
      validateMcpManagerConfig({
        mcpManager: { servers: catalog.servers, groups: { "acme-data": ["acme-missing"] } },
      }),
    ).toThrow('mcpManager.groups.acme-data: unknown MCP server "acme-missing"');
  });

  test("rejects a name shared by a server and a group", () => {
    expect(() =>
      validateMcpManagerConfig({
        mcpManager: { servers: { acme: { command: "x" } }, groups: { acme: ["acme"] } },
      }),
    ).toThrow('"acme" names both a server and a group');
  });

  test("rejects env given as a mapping without repeating the value", () => {
    const run = () =>
      validateMcpManagerConfig(
        withServer("acme-x", { command: "x", env: { ACME_TOKEN: "s3cr3t" } }),
      );
    expect(run).toThrow("mcpManager.servers.acme-x: env lists variable names only");
    expect(run).not.toThrow("s3cr3t");
  });

  test("rejects an env entry that is not a variable name without repeating it", () => {
    const run = () =>
      validateMcpManagerConfig(withServer("acme-x", { command: "x", env: ["s3cr3t"] }));
    expect(run).toThrow("env entry 1 is not a variable name");
    expect(run).not.toThrow("s3cr3t");
  });

  test("rejects a literal header value, naming server and header, not the value", () => {
    const run = () =>
      validateMcpManagerConfig(
        withServer("acme-x", {
          url: "https://a.example",
          headers: { Authorization: "Bearer s3cr3t" },
        }),
      );
    expect(run).toThrow('mcpManager.servers.acme-x: header "Authorization" must be');
    expect(run).not.toThrow("s3cr3t");
  });

  test("rejects a header holding two references", () => {
    expect(() =>
      validateMcpManagerConfig(
        withServer("acme-x", { url: "https://a.example", headers: { "X-Key": "${A}${B}" } }),
      ),
    ).toThrow('header "X-Key" must be');
  });

  test("rejects headers on a stdio server", () => {
    expect(() =>
      validateMcpManagerConfig(withServer("acme-x", { command: "x", headers: {} })),
    ).toThrow('unknown key "headers"');
  });

  test("rejects an unknown transport", () => {
    expect(() =>
      validateMcpManagerConfig(withServer("acme-x", { url: "https://a.example", transport: "ws" })),
    ).toThrow("transport must be one of http, sse");
  });

  test("rejects a base selection naming an unknown server", () => {
    expect(() =>
      validateMcpManagerConfig({
        mcpManager: { servers: catalog.servers, enabled: { servers: ["acme-missing"] } },
      }),
    ).toThrow('mcpManager.enabled: unknown MCP server "acme-missing"');
  });
});

describe("audience mcpManager", () => {
  test("accepts enable and disable naming catalog entries", () => {
    expect(() =>
      validateMcpManagerConfig(
        withAudience({ enable: { servers: ["acme-api"] }, disable: { groups: ["acme-data"] } }),
      ),
    ).not.toThrow();
  });

  test("rejects an undeclared server, naming the audience", () => {
    expect(() =>
      validateMcpManagerConfig(withAudience({ enable: { servers: ["acme-missing"] } })),
    ).toThrow('audience "analyst": mcpManager.enable: unknown MCP server "acme-missing"');
  });

  test("rejects an audience declaring its own servers", () => {
    expect(() => validateMcpManagerConfig(withAudience({ servers: {} }))).toThrow(
      'audience "analyst": mcpManager: unknown key "servers"',
    );
  });

  test("rejects a server both enabled and disabled at one level", () => {
    expect(() =>
      validateMcpManagerConfig(
        withAudience({ enable: { servers: ["acme-db"] }, disable: { servers: ["acme-db"] } }),
      ),
    ).toThrow('audience "analyst": mcpManager: "acme-db" is both enabled and disabled');
  });

  test("rejects references when the companion declares no catalog", () => {
    expect(() =>
      validateMcpManagerConfig({
        audiences: { analyst: { mcpManager: { enable: { groups: ["acme-data"] } } } },
      }),
    ).toThrow('unknown MCP server group "acme-data"');
  });
});
