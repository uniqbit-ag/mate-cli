import crypto from "node:crypto";

import type { CompanionMcpServer } from "./companion-mcp-config";

/**
 * Canonical hash of what actually spawns: command, args, env, cwd. Identity
 * fields (`name`) and lifecycle fields (`isolation`, `enabled`) are excluded —
 * they change how the gateway uses a backend, never what the backend is, so
 * cached manifests survive renames and isolation flips.
 */
export function serverConfigHash(server: CompanionMcpServer): string {
  const canonical = JSON.stringify({
    command: server.command,
    args: server.args,
    env: Object.fromEntries(Object.entries(server.env).sort(([a], [b]) => (a < b ? -1 : 1))),
    cwd: server.cwd,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
