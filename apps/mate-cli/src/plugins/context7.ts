import type { CapabilityPlugin } from "@uniqbit/mate-core";

export function createContext7Plugin(): CapabilityPlugin {
  return {
    id: "context7",
    kind: "capability",
    label: "Context7",
    description: "Up-to-date library docs via the Context7 MCP server.",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "context7"),
    async apply(ctx) {
      await ctx.mcp?.register({
        name: "context7",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      });
    },
    async teardown() {},
  };
}
