import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { GatewayDaemon, GatewayDaemonAlreadyRunningError, readGatewayState } from "./daemon";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import { gatewayPaths } from "./gateway-paths";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => {})));
});

async function makeDaemon(options: { idleShutdownMs?: number; version?: string } = {}) {
  const mateHome = await fs.mkdtemp(path.join(os.tmpdir(), "gwd-"));
  const paths = gatewayPaths(mateHome);
  const daemon = new GatewayDaemon({
    version: options.version ?? "1.0.0",
    paths,
    idleShutdownMs: options.idleShutdownMs ?? Infinity,
    logger: NULL_GATEWAY_LOGGER,
  });
  cleanups.push(async () => {
    await daemon.stop();
    await fs.rm(mateHome, { recursive: true, force: true });
  });
  return { daemon, paths, mateHome };
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("GatewayDaemon", () => {
  test("start binds the socket, restricts the run dir, and writes the state file", async () => {
    const { daemon, paths } = await makeDaemon({ version: "2.3.4" });

    await daemon.start();

    const stat = await fs.stat(paths.runDir);
    expect(stat.mode & 0o777).toBe(0o700);
    const state = await readGatewayState(paths.statePath);
    expect(state).toMatchObject({
      pid: process.pid,
      version: "2.3.4",
      socketPath: paths.socketPath,
    });
    const socket = await connect(paths.socketPath);
    socket.destroy();
  });

  test("second daemon on a live socket fails with AlreadyRunning", async () => {
    const { daemon, paths } = await makeDaemon();
    await daemon.start();

    const rival = new GatewayDaemon({
      version: "1.0.0",
      paths,
      idleShutdownMs: Infinity,
      logger: NULL_GATEWAY_LOGGER,
    });

    expect(rival.start()).rejects.toBeInstanceOf(GatewayDaemonAlreadyRunningError);
  });

  test("a stale socket file from a dead daemon is replaced", async () => {
    const { daemon, paths } = await makeDaemon();
    await fs.mkdir(paths.runDir, { recursive: true });
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(paths.socketPath, resolve));
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    // close() removes the file on some platforms; recreate the stale entry.
    await fs.writeFile(paths.socketPath, "").catch(() => {});
    const staleServer = net.createServer();

    await daemon.start();

    const socket = await connect(paths.socketPath);
    socket.destroy();
    staleServer.close();
  });

  test("idle timer shuts the daemon down and cleans up socket and state", async () => {
    const { daemon, paths } = await makeDaemon({ idleShutdownMs: 50 });

    await daemon.start();
    await daemon.whenStopped;

    expect(await readGatewayState(paths.statePath)).toBeNull();
    expect(fs.access(paths.socketPath)).rejects.toThrow();
  });

  test("an open connection blocks idle shutdown; closing it re-arms the timer", async () => {
    const { daemon, paths } = await makeDaemon({ idleShutdownMs: 80 });
    await daemon.start();

    const socket = await connect(paths.socketPath);
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(daemon.connectionCount).toBe(1);
    expect(await readGatewayState(paths.statePath)).not.toBeNull();

    socket.destroy();
    await daemon.whenStopped;
    expect(await readGatewayState(paths.statePath)).toBeNull();
  });

  test("stop destroys live connections and resolves whenStopped", async () => {
    const { daemon, paths } = await makeDaemon();
    await daemon.start();
    const socket = await connect(paths.socketPath);

    await daemon.stop();
    await daemon.whenStopped;

    expect(daemon.connectionCount).toBe(0);
    socket.destroy();
  });
});
