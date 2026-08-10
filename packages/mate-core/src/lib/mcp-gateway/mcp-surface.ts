import type { CompanionMcpServer } from "./companion-mcp-config";
import type { GatewayConnection, McpSurface } from "./connection";
import type { JsonRpcMessage } from "./frames";
import type { GatewayLogger } from "./gateway-log";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import {
  buildToolNamespace,
  toWireTool,
  type McpToolDescriptor,
  type PublicTool,
} from "./tool-namespace";

/**
 * Where per-connection tools come from and where calls go. Implemented by the
 * backend layer (manifest cache + supervisor); tests stub it.
 */
export interface ToolSource {
  listTools(
    server: CompanionMcpServer,
    connection: GatewayConnection,
  ): Promise<McpToolDescriptor[]>;
  callTool(
    server: CompanionMcpServer,
    toolName: string,
    args: unknown,
    connection: GatewayConnection,
  ): Promise<unknown>;
}

export interface GatewayMcpSurfaceOptions {
  version: string;
  toolSource: ToolSource;
  logger?: GatewayLogger;
  /** Re-resolve hook: runs before each `tools/list` as the fs-watch fallback. */
  beforeToolsList?: (connection: GatewayConnection) => Promise<void>;
}

const FALLBACK_PROTOCOL_VERSION = "2024-11-05";

export class GatewayMcpSurface implements McpSurface {
  private readonly options: GatewayMcpSurfaceOptions;
  private readonly logger: GatewayLogger;
  /** Last published namespace per connection id — `tools/call` routes through it. */
  private readonly namespaces = new Map<number, PublicTool[]>();

  constructor(options: GatewayMcpSurfaceOptions) {
    this.options = options;
    this.logger = options.logger ?? NULL_GATEWAY_LOGGER;
  }

  releaseConnection(connection: GatewayConnection): void {
    this.namespaces.delete(connection.id);
  }

  async publicToolsFor(connection: GatewayConnection): Promise<PublicTool[]> {
    const serverTools = await Promise.all(
      connection.resolution.servers.map(async (server) => ({
        server,
        tools: await this.options.toolSource.listTools(server, connection).catch((error) => {
          this.logger.log("error", "surface.list_tools_failed", {
            connection: connection.id,
            server: server.name,
            error: (error as Error).message,
          });
          return [] as McpToolDescriptor[];
        }),
      })),
    );
    const publicTools = buildToolNamespace(serverTools);
    this.namespaces.set(connection.id, publicTools);
    return publicTools;
  }

  async handleRequest(connection: GatewayConnection, message: JsonRpcMessage): Promise<void> {
    if (message.method === undefined) return; /* stray response frame */
    const respond = (result: unknown) => {
      if (message.id !== undefined) {
        connection.sendRpc({ jsonrpc: "2.0", id: message.id, result });
      }
    };
    const fail = (code: number, errorMessage: string) => {
      if (message.id !== undefined) {
        connection.sendRpc({
          jsonrpc: "2.0",
          id: message.id,
          error: { code, message: errorMessage },
        });
      }
    };

    switch (message.method) {
      case "initialize": {
        const params = message.params as { protocolVersion?: unknown } | undefined;
        respond({
          protocolVersion:
            typeof params?.protocolVersion === "string"
              ? params.protocolVersion
              : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "mate", version: this.options.version },
        });
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        respond({});
        return;
      case "tools/list": {
        await this.options.beforeToolsList?.(connection);
        const tools = await this.publicToolsFor(connection);
        this.logger.log("debug", "surface.tools_list", {
          connection: connection.id,
          tools: tools.map((tool) => tool.publicName),
        });
        respond({ tools: tools.map(toWireTool) });
        return;
      }
      case "tools/call": {
        const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
        if (typeof params?.name !== "string") {
          fail(-32602, "tools/call requires a tool name");
          return;
        }
        const namespace =
          this.namespaces.get(connection.id) ?? (await this.publicToolsFor(connection));
        const tool = namespace.find((candidate) => candidate.publicName === params.name);
        if (!tool) {
          fail(-32602, `unknown tool: ${params.name}`);
          return;
        }
        const server = connection.resolution.servers.find(
          (candidate) => candidate.name === tool.serverName,
        );
        if (!server) {
          fail(-32602, `tool ${params.name} belongs to a server no longer configured`);
          return;
        }
        try {
          respond(
            await this.options.toolSource.callTool(
              server,
              tool.toolName,
              params.arguments ?? {},
              connection,
            ),
          );
        } catch (error) {
          fail(-32603, `mate gateway: tool call failed: ${(error as Error).message}`);
        }
        return;
      }
      case "resources/list":
        respond({ resources: [] });
        return;
      case "prompts/list":
        respond({ prompts: [] });
        return;
      default:
        fail(-32601, `method not supported by mate gateway: ${message.method}`);
    }
  }
}
