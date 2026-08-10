import path from "node:path";

import { CompanionResolver } from "../orchestrator/companion-resolver";
import { GlobalConfigStore } from "../orchestrator/global-config-store";
import { findRepoLocalRegistryFile } from "../orchestrator/repo-local-registry";
import type { ConnectionResolution, ConnectionResolver } from "./connection";
import type { GatewayLogger } from "./gateway-log";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import { resolveCompanionMcpServers } from "./legacy-mcp-config";

export interface GatewayConnectionResolverDeps {
  globalConfigStore?: GlobalConfigStore;
  logger?: GatewayLogger;
}

/**
 * directory → repo root → trust-gated pin → companion MCP config. Reuses the
 * same `CompanionResolver` the session activation paths use, so a repo that
 * would not activate Mate (unlinked, untrusted pointer, dropped companion)
 * yields an inactive connection with an empty server set.
 */
export class GatewayConnectionResolver implements ConnectionResolver {
  private readonly resolver: CompanionResolver;
  private readonly logger: GatewayLogger;

  constructor(deps: GatewayConnectionResolverDeps = {}) {
    this.resolver = new CompanionResolver(deps.globalConfigStore ?? new GlobalConfigStore());
    this.logger = deps.logger ?? NULL_GATEWAY_LOGGER;
  }

  async resolveConnection(cwd: string): Promise<ConnectionResolution> {
    const resolvedCwd = path.resolve(cwd);
    const found = await findRepoLocalRegistryFile(resolvedCwd);
    const repoRoot = found?.repoRoot ?? null;

    const result = await this.resolver.resolveWithDiagnostics(resolvedCwd, { logFailures: false });
    for (const failure of result.failures) {
      this.logger.log("warn", "resolution.failure", {
        cwd: resolvedCwd,
        companionPath: failure.companionPath,
        message: failure.message,
      });
    }
    if (!result.match) {
      return { repoRoot, companionPath: null, servers: [] };
    }

    const companionPath = result.match.companionPath;
    const config = await resolveCompanionMcpServers(companionPath);
    for (const issue of config.issues) {
      this.logger.log("warn", "resolution.config_issue", {
        companionPath,
        server: issue.server,
        message: issue.message,
      });
    }
    for (const deprecation of config.deprecations) {
      this.logger.log("warn", "resolution.deprecation", { companionPath, message: deprecation });
    }

    return {
      repoRoot,
      companionPath,
      servers: config.servers.filter((server) => server.enabled),
    };
  }
}
