/** Remote transports a declared server may name; absent means `http`. */
export const MCP_MANAGER_TRANSPORTS = ["http", "sse"] as const;
export type McpManagerTransport = (typeof MCP_MANAGER_TRANSPORTS)[number];

/** Fields every declared server shares. Holds variable names, never values. */
interface McpManagerServerBase {
  /** Environment variable names the server reads, rendered as runtime references. */
  env?: string[];
}

/** A server Mate starts as a local process. */
export interface McpManagerStdioServer extends McpManagerServerBase {
  command: string;
  args?: string[];
}

/** A server Mate reaches over the network. */
export interface McpManagerRemoteServer extends McpManagerServerBase {
  url: string;
  transport?: McpManagerTransport;
  /** Header name to `<scheme prefix>${NAME}`, e.g. `Bearer ${ACME_KEY}`. */
  headers?: Record<string, string>;
}

export type McpManagerServer = McpManagerStdioServer | McpManagerRemoteServer;

/** Server and group names, as a selection lists them. */
export interface McpManagerSelection {
  servers?: string[];
  groups?: string[];
}

/** The `mcpManager` section at the root of `framework.yaml`. */
export interface McpManagerConfig {
  servers?: Record<string, McpManagerServer>;
  /** Group name to member server names. */
  groups?: Record<string, string[]>;
  /** The base selection. */
  enabled?: McpManagerSelection;
}

/** `audiences.<name>.mcpManager`: selects from the root catalog only. */
export interface McpManagerAudienceSelection {
  enable?: McpManagerSelection;
  disable?: McpManagerSelection;
}

/** A header value split into its literal prefix and the one variable it references. */
export interface McpManagerHeaderRef {
  prefix: string;
  variable: string;
}

/** One server of an effective set, ready to become an MCP descriptor. */
export interface ResolvedMcpServer {
  name: string;
  server: McpManagerServer;
}
