import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export interface SpawnProxyOpts {
  port: number;
}

export interface WaitForProxyReachableOptions {
  attempts?: number;
  delayMs?: number;
  probe?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

export function resolveHeadroomPort(): number {
  const portStr = process.env.HEADROOM_PORT;
  if (portStr) {
    const parsed = parseInt(portStr, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 8787;
}

export function isProxyReachable(port: number): Promise<boolean> {
  const readyFile = process.env.MATE_E2E_HEADROOM_PROXY_READY_FILE;
  if (readyFile && existsSync(readyFile)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/livez", timeout: 2000 }, (res) => {
      const statusCode = res.statusCode ?? 0;
      resolve(statusCode >= 200 && statusCode < 300);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function waitForProxyReachable(
  port: number,
  options: WaitForProxyReachableOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 250;
  const probe = options.probe ?? isProxyReachable;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe(port)) {
      return true;
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return false;
}

// Global map to store proxy stderr for error reporting. Keyed by port number.
const proxyStderr = new Map<number, string>();
const proxyStderrLogPath = new Map<number, string>();

export function spawnProxyBackground(opts: SpawnProxyOpts, spawnFn: typeof spawn = spawn): void {
  // Persistent memory is intentionally not enabled: headroom treats memory as
  // opt-in (`--memory`), so a bare `proxy --port` runs compression-only with no
  // memory DB writes.
  const args = ["proxy", "--port", String(opts.port)];

  let stderrBuffer = "";
  const stderrLogPath = path.join(os.tmpdir(), `mate-headroom-proxy-${opts.port}.stderr.log`);
  proxyStderrLogPath.set(opts.port, stderrLogPath);
  const stderrFd = openSync(stderrLogPath, "w");
  const child = spawnFn("headroom", args, {
    detached: true,
    stdio: ["ignore", "ignore", stderrFd],
    env: { ...process.env, HEADROOM_OUTPUT_SHAPER: "0", HEADROOM_TELEMETRY: "off" },
  });
  closeSync(stderrFd);

  // Tests may inject a mocked child.stderr; real detached launches use a log file.
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });
    child.stderr.on("end", () => {
      proxyStderr.set(opts.port, stderrBuffer);
    });
  }

  child.unref();
}

export function getProxyStderr(port: number): string {
  const buffered = proxyStderr.get(port);
  if (buffered) return buffered;

  const logPath = proxyStderrLogPath.get(port);
  if (!logPath || !existsSync(logPath)) return "";

  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}
