import net from "node:net";

import { socketIsAlive } from "./daemon";
import { createLineReader, encodeControl, parseFrame } from "./frames";
import type { GatewayStatus } from "./gateway";
import { gatewayPaths, type GatewayPaths } from "./gateway-paths";

/**
 * Reads a live daemon's status over the socket. Returns null when no daemon
 * is running — and never starts one.
 */
export async function fetchGatewayStatus(
  paths: GatewayPaths = gatewayPaths(),
  timeoutMs = 5000,
): Promise<GatewayStatus | null> {
  if (!(await socketIsAlive(paths.socketPath))) return null;
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const candidate = net.connect(paths.socketPath);
    candidate.once("connect", () => resolve(candidate));
    candidate.once("error", reject);
  }).catch(() => null);
  if (!socket) return null;

  return new Promise<GatewayStatus | null>((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    socket.on(
      "data",
      createLineReader((line) => {
        const frame = parseFrame(line);
        if (frame.kind === "control" && frame.control.type === "status-reply") {
          clearTimeout(timer);
          socket.destroy();
          resolve(frame.control.status as GatewayStatus);
        }
      }),
    );
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(null);
    });
    socket.write(encodeControl({ type: "status" }));
  });
}
