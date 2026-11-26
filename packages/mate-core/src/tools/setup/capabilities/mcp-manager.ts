// oxlint-disable no-await-in-loop
import { resolveMcpServers } from "../../../lib/mcp-manager/resolve";
import type { ResolvedMcpServer } from "../../../lib/mcp-manager/types";
import { parseHeaderRef } from "../../../lib/mcp-manager/validate";
import { readAudienceSelection } from "../dynamic-plugins/audiences";
import type { CapabilityPlugin, McpServerDescriptor } from "../plugin";

export const MCP_MANAGER_PLUGIN_ID = "mcp-manager";

/** A validated declared server as a descriptor holding references only. */
export function toMcpServerDescriptor({ name, server }: ResolvedMcpServer): McpServerDescriptor {
  const envRefs = server.env?.length ? { envRefs: server.env } : {};
  if ("command" in server) {
    return {
      name,
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...envRefs,
    };
  }
  const headerRefs = Object.entries(server.headers ?? {}).flatMap(([header, value]) => {
    const ref = parseHeaderRef(value);
    return ref ? [[header, ref] as const] : [];
  });
  return {
    name,
    url: server.url,
    transport: server.transport ?? "http",
    ...envRefs,
    ...(headerRefs.length > 0 ? { headerRefs: Object.fromEntries(headerRefs) } : {}),
  };
}

/**
 * Renders the companion's `mcpManager` servers for the audience in
 * `MATE_AUDIENCE` into every active Agent Runtime. Enabled by the section
 * alone, so it never appears in a setup selector.
 */
export function createMcpManagerPlugin(
  env: Record<string, string | undefined> = process.env,
): CapabilityPlugin {
  return {
    id: MCP_MANAGER_PLUGIN_ID,
    kind: "capability",
    label: "MCP Manager",
    description: "MCP servers the companion declares in framework.yaml.",
    defaultSelected: false,
    selectable: false,
    isEnabled: (config) => config.mcpManager !== undefined,
    getInstallRequirements: () => [],
    async apply(ctx) {
      const servers = resolveMcpServers(ctx.config, readAudienceSelection(env));
      if (servers.length === 0) return;
      const owners = (await ctx.mcp?.owners?.()) ?? new Map<string, string>();
      const declared = Object.keys(ctx.config.mcpManager?.servers ?? {});
      const clashes = declared.flatMap((name) => {
        const owner = owners.get(name);
        return owner ? [`"${name}" (also registered by the "${owner}" Capability)`] : [];
      });
      if (clashes.length > 0) {
        const reason = `${MCP_MANAGER_PLUGIN_ID}: error: mcpManager declares MCP server ${clashes.join(", ")}; rename it in mcpManager.servers. No mcpManager server was rendered.`;
        if (ctx.mcp?.withhold) {
          ctx.mcp.withhold(reason);
          return;
        }
        throw new Error(reason);
      }
      for (const server of servers) {
        await ctx.mcp?.register(toMcpServerDescriptor(server));
      }
    },
    async teardown() {},
  };
}
