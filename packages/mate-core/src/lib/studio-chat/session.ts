import type { ChatHarness } from "./agent";

/**
 * Built-in tools the chat offers, by each harness's names: reading and searching files, and
 * loading a skill's text. OpenCode's skill tool is its own, not a harness built-in, so it stays
 * on without being named.
 */
export const CHAT_TOOLS: Readonly<Record<ChatHarness, readonly string[]>> = {
  "claude-code": ["read", "grep", "glob", "Skill"],
  opencode: ["read", "grep", "glob"],
};

/** The MCP servers and Claude Code plugins a chat turn loads, by name only. */
export interface ChatSession {
  mcpServers: string[];
  plugins: string[];
}

/**
 * What a chat turn loads, read without starting an agent. A turn runs on a fresh HOME whose
 * settings enable nothing (`createHostSandbox`); Claude Code's `strictMcpConfig` drops the
 * companion's `.mcp.json`, and OpenCode loads no project configuration, so neither harness loads
 * MCP servers or plugins.
 */
export function chatSession(): ChatSession {
  return { mcpServers: [], plugins: [] };
}
