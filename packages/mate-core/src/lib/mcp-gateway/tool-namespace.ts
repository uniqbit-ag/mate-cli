import type { CompanionMcpServer } from "./companion-mcp-config";

/** MCP tool descriptor as reported by a backend's `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface PublicTool {
  /** Flat public name: `mate__<tool>`, or `mate__<server>_<tool>` for colliders. */
  publicName: string;
  serverName: string;
  toolName: string;
  descriptor: McpToolDescriptor;
}

export const MATE_TOOL_PREFIX = "mate__";

/**
 * Builds the flat public namespace for one connection. Only tools whose bare
 * name appears in more than one server get the `<server>_` qualifier, so
 * public names never change unless a real collision appears.
 */
export function buildToolNamespace(
  serverTools: Array<{ server: CompanionMcpServer; tools: McpToolDescriptor[] }>,
): PublicTool[] {
  const nameCounts = new Map<string, number>();
  for (const { tools } of serverTools) {
    for (const tool of tools) {
      nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
    }
  }

  const publicTools: PublicTool[] = [];
  for (const { server, tools } of serverTools) {
    for (const tool of tools) {
      const collides = (nameCounts.get(tool.name) ?? 0) > 1;
      publicTools.push({
        publicName: collides
          ? `${MATE_TOOL_PREFIX}${server.name}_${tool.name}`
          : `${MATE_TOOL_PREFIX}${tool.name}`,
        serverName: server.name,
        toolName: tool.name,
        descriptor: tool,
      });
    }
  }

  publicTools.sort((a, b) => (a.publicName < b.publicName ? -1 : 1));
  return publicTools;
}

/** Wire descriptor for `tools/list`: public name, origin server named in the description. */
export function toWireTool(tool: PublicTool): McpToolDescriptor {
  const baseDescription = tool.descriptor.description?.trim();
  const origin = `via mate server "${tool.serverName}"`;
  return {
    ...tool.descriptor,
    name: tool.publicName,
    description: baseDescription ? `${baseDescription} (${origin})` : origin,
  };
}
