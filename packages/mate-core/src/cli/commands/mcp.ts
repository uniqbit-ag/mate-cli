import { spawn } from "node:child_process";

import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import { GatewayDaemonAlreadyRunningError } from "../../lib/mcp-gateway/daemon";
import { createGateway } from "../../lib/mcp-gateway/gateway";
import type {
  GatewayStatus,
  GatewayStatusBackend,
  GatewayStatusManifest,
} from "../../lib/mcp-gateway/gateway";
import { gatewayPaths, type GatewayPaths } from "../../lib/mcp-gateway/gateway-paths";
import { runShim } from "../../lib/mcp-gateway/shim";
import { fetchGatewayStatus } from "../../lib/mcp-gateway/status-client";

export interface McpCommandDeps {
  paths: GatewayPaths;
  version: string;
  fetchGatewayStatus: typeof fetchGatewayStatus;
  runShim: typeof runShim;
  createGateway: typeof createGateway;
  spawnDetachedDaemon: () => Promise<void>;
}

function defaultDeps(): McpCommandDeps {
  const paths = gatewayPaths();
  return {
    paths,
    version: getActiveDistribution().config.version,
    fetchGatewayStatus,
    runShim,
    createGateway,
    spawnDetachedDaemon: async () => {
      /* Re-invoke this same CLI entry as a detached daemon process. */
      const child = spawn(process.argv[0]!, [process.argv[1]!, "mcp", "daemon"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    },
  };
}

export async function runMcpCommand(
  subcommand: string | undefined,
  rest: string[],
  deps: McpCommandDeps = defaultDeps(),
): Promise<void> {
  switch (subcommand) {
    case "shim": {
      await deps.runShim({
        version: deps.version,
        cwd: process.cwd(),
        paths: deps.paths,
        spawnDaemon: deps.spawnDetachedDaemon,
      });
      return;
    }
    case "daemon": {
      const gateway = deps.createGateway({ version: deps.version, paths: deps.paths });
      try {
        await gateway.start();
      } catch (error) {
        if (error instanceof GatewayDaemonAlreadyRunningError) {
          /* Lost the shim spawn race — the winner serves everyone. */
          console.error(`${FRAMEWORK_NAME}: ${error.message}`);
          return;
        }
        throw error;
      }
      const shutdown = () => void gateway.stop();
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await gateway.runtime.daemon.whenStopped;
      return;
    }
    case "status": {
      const asJson = rest.includes("--json");
      const status = await deps.fetchGatewayStatus(deps.paths);
      if (!status) {
        if (asJson) {
          console.log(JSON.stringify({ running: false }));
        } else {
          console.log(`${FRAMEWORK_NAME} MCP gateway daemon is not running.`);
        }
        return;
      }
      if (asJson) {
        console.log(JSON.stringify({ running: true, ...status }, null, 2));
        return;
      }
      console.log(formatStatus(status));
      return;
    }
    default:
      console.error(
        `Usage: ${FRAMEWORK_NAME} mcp <shim|daemon|status>\n` +
          `  shim    stdio MCP gateway endpoint for agent hosts (auto-starts the daemon)\n` +
          `  daemon  run the gateway daemon in the foreground\n` +
          `  status  report daemon version, connections, backends, manifest cache [--json]`,
      );
      process.exitCode = 1;
  }
}

function formatStatus(status: GatewayStatus): string {
  const lines = [
    `${FRAMEWORK_NAME} MCP gateway daemon`,
    `  version: ${status.version}`,
    `  pid: ${status.pid}`,
    "",
    `Connections (${status.connections.length}):`,
  ];
  for (const connection of status.connections) {
    lines.push(
      `  #${connection.id} repo=${connection.repoRoot ?? "(none)"} companion=${connection.companionPath ?? "(inactive)"} servers=[${connection.servers.join(", ")}]`,
    );
  }
  const backends = (status.backends ?? []) as GatewayStatusBackend[];
  lines.push("", `Running backends (${backends.length}):`);
  for (const backend of backends) {
    const scope =
      backend.isolation === "connection" ? ` connection=#${backend.connectionId}` : " shared";
    lines.push(
      `  ${backend.server} pid=${backend.pid ?? "?"} idle=${Math.round(backend.idleMs / 1000)}s${scope}`,
    );
  }
  const manifests = (status.manifestCache ?? []) as GatewayStatusManifest[];
  lines.push("", `Manifest cache (${manifests.length}):`);
  for (const manifest of manifests) {
    lines.push(
      `  ${manifest.configHash.slice(0, 12)} tools=${manifest.toolCount} command=${manifest.command}`,
    );
  }
  return lines.join("\n");
}
