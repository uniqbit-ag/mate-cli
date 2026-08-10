import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";

export interface GatewayPaths {
  mateHome: string;
  /** 0700 — the socket inherits user-only access from its directory. */
  runDir: string;
  socketPath: string;
  statePath: string;
  logDir: string;
  logPath: string;
  cacheDir: string;
  manifestCachePath: string;
}

export function gatewayPaths(
  mateHome = path.join(os.homedir(), `.${FRAMEWORK_NAME}`),
): GatewayPaths {
  const runDir = path.join(mateHome, "run");
  const logDir = path.join(mateHome, "logs");
  const cacheDir = path.join(mateHome, "cache");
  return {
    mateHome,
    runDir,
    socketPath: path.join(runDir, "gateway.sock"),
    statePath: path.join(runDir, "gateway.json"),
    logDir,
    logPath: path.join(logDir, "mcp-gateway.log"),
    cacheDir,
    manifestCachePath: path.join(cacheDir, "mcp-manifests.json"),
  };
}
