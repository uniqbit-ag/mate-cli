import { describe, expect, test } from "bun:test";

import type { CompanionMcpServer } from "./companion-mcp-config";
import type { GatewayConnection } from "./connection";
import type { JsonRpcMessage } from "./frames";
import { GatewayMcpSurface, type ToolSource } from "./mcp-surface";
import { buildToolNamespace, toWireTool } from "./tool-namespace";

function server(name: string): CompanionMcpServer {
  return {
    name,
    command: `${name}-bin`,
    args: [],
    env: {},
    cwd: "/companions/acme",
    isolation: "shared",
    enabled: true,
  };
}

interface FakeConnection {
  id: number;
  resolution: {
    repoRoot: string | null;
    companionPath: string | null;
    servers: CompanionMcpServer[];
  };
  sent: JsonRpcMessage[];
  sendRpc(message: JsonRpcMessage): void;
}

function fakeConnection(servers: CompanionMcpServer[], id = 1): FakeConnection {
  const sent: JsonRpcMessage[] = [];
  return {
    id,
    resolution: { repoRoot: "/repos/acme", companionPath: "/companions/acme", servers },
    sent,
    sendRpc(message) {
      sent.push(message);
    },
  };
}

function asGatewayConnection(connection: FakeConnection): GatewayConnection {
  return connection as unknown as GatewayConnection;
}

describe("buildToolNamespace", () => {
  test("prefixes tools with mate__ and sorts deterministically", () => {
    const namespace = buildToolNamespace([
      { server: server("docs"), tools: [{ name: "search" }, { name: "read" }] },
    ]);

    expect(namespace.map((tool) => tool.publicName)).toEqual(["mate__read", "mate__search"]);
  });

  test("qualifies only colliding names with the server", () => {
    const namespace = buildToolNamespace([
      { server: server("docs"), tools: [{ name: "search" }, { name: "unique" }] },
      { server: server("api"), tools: [{ name: "search" }] },
    ]);

    expect(namespace.map((tool) => tool.publicName)).toEqual([
      "mate__api_search",
      "mate__docs_search",
      "mate__unique",
    ]);
  });

  test("wire descriptors keep the schema and name the origin server", () => {
    const namespace = buildToolNamespace([
      {
        server: server("docs"),
        tools: [{ name: "search", description: "Find things", inputSchema: { type: "object" } }],
      },
    ]);

    const wire = toWireTool(namespace[0]!);
    expect(wire.name).toBe("mate__search");
    expect(wire.description).toBe('Find things (via mate server "docs")');
    expect(wire.inputSchema).toEqual({ type: "object" });
  });
});

function makeSurface(overrides: Partial<ToolSource> = {}) {
  const calls: Array<{ server: string; tool: string; args: unknown }> = [];
  const toolSource: ToolSource = {
    async listTools(target) {
      if (target.name === "docs") return [{ name: "search" }, { name: "read" }];
      if (target.name === "api") return [{ name: "search" }];
      return [];
    },
    async callTool(target, toolName, args) {
      calls.push({ server: target.name, tool: toolName, args });
      return { content: [{ type: "text", text: `${target.name}:${toolName}` }] };
    },
    ...overrides,
  };
  return { surface: new GatewayMcpSurface({ version: "1.0.0", toolSource }), calls };
}

async function roundTrip(
  surface: GatewayMcpSurface,
  connection: FakeConnection,
  message: JsonRpcMessage,
): Promise<JsonRpcMessage | undefined> {
  await surface.handleRequest(asGatewayConnection(connection), message);
  return connection.sent.at(-1);
}

describe("GatewayMcpSurface", () => {
  test("initialize advertises tools with listChanged and the mate identity", async () => {
    const { surface } = makeSurface();
    const connection = fakeConnection([server("docs")]);

    const reply = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });

    expect(reply?.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "mate", version: "1.0.0" },
    });
  });

  test("tools/list exposes the mate__ namespace with collision qualification", async () => {
    const { surface } = makeSurface();
    const connection = fakeConnection([server("docs"), server("api")]);

    const reply = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const tools = (reply?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "mate__api_search",
      "mate__docs_search",
      "mate__read",
    ]);
  });

  test("tools/list is empty for an inactive connection", async () => {
    const { surface } = makeSurface();
    const connection = fakeConnection([]);

    const reply = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });

    expect(reply?.result).toEqual({ tools: [] });
  });

  test("tools/call routes the public name to the owning server's bare tool", async () => {
    const { surface, calls } = makeSurface();
    const connection = fakeConnection([server("docs"), server("api")]);
    await roundTrip(surface, connection, { jsonrpc: "2.0", id: 4, method: "tools/list" });

    const reply = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "mate__api_search", arguments: { q: "x" } },
    });

    expect(calls).toEqual([{ server: "api", tool: "search", args: { q: "x" } }]);
    expect(reply?.result).toEqual({ content: [{ type: "text", text: "api:search" }] });
  });

  test("tools/call without a prior tools/list still resolves the namespace", async () => {
    const { surface, calls } = makeSurface();
    const connection = fakeConnection([server("docs")]);

    const reply = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "mate__read", arguments: {} },
    });

    expect(calls).toEqual([{ server: "docs", tool: "read", args: {} }]);
    expect(reply?.error).toBeUndefined();
  });

  test("unknown tools and unsupported methods return JSON-RPC errors", async () => {
    const { surface } = makeSurface();
    const connection = fakeConnection([server("docs")]);

    const unknownTool = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "mate__nope" },
    });
    expect(unknownTool?.error?.message).toContain("unknown tool");

    const unsupported = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 8,
      method: "sampling/createMessage",
    });
    expect(unsupported?.error?.code).toBe(-32601);
  });

  test("a failing backend call surfaces as a JSON-RPC error, not a crash", async () => {
    const { surface } = makeSurface({
      async callTool() {
        throw new Error("backend exploded");
      },
    });
    const connection = fakeConnection([server("docs")]);

    const reply = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "mate__read" },
    });

    expect(reply?.error?.message).toContain("backend exploded");
  });

  test("a failing listTools for one server keeps the other server's tools", async () => {
    const { surface } = makeSurface({
      async listTools(target) {
        if (target.name === "docs") throw new Error("spawn failed");
        return [{ name: "healthy" }];
      },
    });
    const connection = fakeConnection([server("docs"), server("api")]);

    const reply = await roundTrip(surface, connection, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
    });

    const tools = (reply?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["mate__healthy"]);
  });

  test("notifications produce no response frames", async () => {
    const { surface } = makeSurface();
    const connection = fakeConnection([server("docs")]);

    await surface.handleRequest(asGatewayConnection(connection), {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(connection.sent).toEqual([]);
  });
});
