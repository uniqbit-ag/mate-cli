import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { CapabilityPlugin } from "@uniqbit/mate-core";

/** Pinned so every machine and the appliance image run the same server; bump with the image lock. */
export const CONTEXT7_MCP_VERSION = "4.1.1";
export const CONTEXT7_MCP_COMMAND = "context7-mcp";
const CONTEXT7_MCP_PACKAGE = `@upstash/context7-mcp@${CONTEXT7_MCP_VERSION}`;
const CONTEXT7_INSTALL_COMMAND = `npm install -g ${CONTEXT7_MCP_PACKAGE}`;

export interface Context7Deps {
  isCommandOnPath(command: string): boolean;
  install(): Promise<void>;
}

function onPath(command: string): boolean {
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      try {
        fs.accessSync(path.join(directory, command + extension), fs.constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

const defaultDeps: Context7Deps = {
  isCommandOnPath: onPath,
  install: () =>
    new Promise((resolve, reject) => {
      const child = spawn("npm", ["install", "-g", CONTEXT7_MCP_PACKAGE], { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`${CONTEXT7_INSTALL_COMMAND} exited ${code}`)),
      );
    }),
};

export function createContext7Plugin(deps: Context7Deps = defaultDeps): CapabilityPlugin {
  const installed = () => deps.isCommandOnPath(CONTEXT7_MCP_COMMAND);
  return {
    id: "context7",
    kind: "capability",
    label: "Context7",
    description: "Up-to-date library docs via the Context7 MCP server.",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "context7"),
    getInstallRequirements: () => [
      {
        id: "capability:context7",
        label: "Context7 MCP server",
        group: "companion",
        source: "Context7 capability",
        command: CONTEXT7_INSTALL_COMMAND,
        fingerprint: `context7:${CONTEXT7_INSTALL_COMMAND}`,
        detect: installed,
        install: () => deps.install(),
        verify: installed,
      },
    ],
    /**
     * The bare command is resolved on PATH when the provider spawns the server, so
     * the committed entry works unchanged on any machine that has it installed.
     */
    async apply(ctx) {
      await ctx.mcp?.register({ name: "context7", command: CONTEXT7_MCP_COMMAND, args: [] });
    },
    async teardown() {},
  };
}
