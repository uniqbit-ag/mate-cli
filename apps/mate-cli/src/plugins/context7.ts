import type { CapabilityPlugin } from "@uniqbit/mate-core";

/** Version pinned by the appliance image. */
export const CONTEXT7_MCP_VERSION = "4.1.1";
export const CONTEXT7_MCP_COMMAND = "context7-mcp";
export const CONTEXT7_MODE_ENV = "MATE_CONTEXT7_MODE";

const CONTEXT7_MCP_PACKAGE = "@upstash/context7-mcp";

export interface Context7Options {
  mode?: "workstation" | "preinstalled";
  platform?: NodeJS.Platform;
}

export function createContext7Plugin(options: Context7Options = {}): CapabilityPlugin {
  const mode =
    options.mode ??
    (process.env[CONTEXT7_MODE_ENV] === "preinstalled" ? "preinstalled" : "workstation");
  let command = CONTEXT7_MCP_COMMAND;
  let args: string[] = [];
  if (mode === "workstation") {
    command = (options.platform ?? process.platform) === "win32" ? "npx.cmd" : "npx";
    args = ["-y", CONTEXT7_MCP_PACKAGE];
  }

  return {
    id: "context7",
    kind: "capability",
    label: "Context7",
    description: "Up-to-date library docs via the Context7 MCP server.",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "context7"),
    getInstallRequirements: () => [],
    async apply(ctx) {
      await ctx.mcp?.register({ name: "context7", command, args });
    },
    async teardown() {},
  };
}
