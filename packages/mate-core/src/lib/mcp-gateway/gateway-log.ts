import fs from "node:fs";
import path from "node:path";

export type GatewayLogLevel = "debug" | "info" | "warn" | "error";

export interface GatewayLogger {
  log(level: GatewayLogLevel, event: string, fields?: Record<string, unknown>): void;
}

/**
 * Append-only JSONL log. Synchronous appends keep entries ordered without a
 * write queue; gateway log volume is a handful of lines per connection.
 */
export function createGatewayLogger(logPath: string): GatewayLogger {
  let dirReady = false;
  return {
    log(level, event, fields = {}) {
      try {
        if (!dirReady) {
          fs.mkdirSync(path.dirname(logPath), { recursive: true });
          dirReady = true;
        }
        fs.appendFileSync(
          logPath,
          `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
        );
      } catch {
        /* logging must never take the daemon down */
      }
    },
  };
}

export const NULL_GATEWAY_LOGGER: GatewayLogger = { log() {} };
