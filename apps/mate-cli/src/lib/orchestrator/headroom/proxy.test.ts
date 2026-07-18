import type { spawn as SpawnFn } from "node:child_process";
import http from "node:http";
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  getProxyStderr,
  isProxyReachable,
  resolveHeadroomPort,
  spawnProxyBackground,
  waitForProxyReachable,
} from "./proxy";

async function withEnv<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

describe("resolveHeadroomPort", () => {
  test("returns 8787 when HEADROOM_PORT is not set", async () => {
    await withEnv("HEADROOM_PORT", undefined, () => {
      expect(resolveHeadroomPort()).toBe(8787);
    });
  });

  test("returns HEADROOM_PORT when it is set", async () => {
    await withEnv("HEADROOM_PORT", "9000", () => {
      expect(resolveHeadroomPort()).toBe(9000);
    });
  });

  test("falls back to 8787 when HEADROOM_PORT is not a valid number", async () => {
    await withEnv("HEADROOM_PORT", "invalid", () => {
      expect(resolveHeadroomPort()).toBe(8787);
    });
  });
});

describe("isProxyReachable", () => {
  const originalGet = http.get;

  afterEach(() => {
    http.get = originalGet;
  });

  test("returns true when server responds with 2xx", async () => {
    http.get = mock((_options, callback) => {
      queueMicrotask(() => {
        callback({
          statusCode: 200,
          resume() {},
        } as http.IncomingMessage);
      });

      return {
        on() {},
        destroy() {},
      } as unknown as http.ClientRequest;
    }) as typeof http.get;

    expect(await isProxyReachable(8787)).toBe(true);
  });

  test("returns false when server responds with non-2xx", async () => {
    http.get = mock((_options, callback) => {
      queueMicrotask(() => {
        callback({
          statusCode: 404,
          resume() {},
        } as http.IncomingMessage);
      });

      return {
        on() {},
        destroy() {},
      } as unknown as http.ClientRequest;
    }) as typeof http.get;

    expect(await isProxyReachable(8787)).toBe(false);
  });

  test("returns false when connection is refused (no server)", async () => {
    http.get = mock(() => {
      const handlers = new Map<string, () => void>();
      queueMicrotask(() => handlers.get("error")?.());

      return {
        on(event: string, handler: () => void) {
          handlers.set(event, handler);
        },
        destroy() {},
      } as unknown as http.ClientRequest;
    }) as typeof http.get;

    expect(await isProxyReachable(8787)).toBe(false);
  });
});

describe("waitForProxyReachable", () => {
  test("returns true once probe becomes reachable", async () => {
    const probe = mock(async () => probe.mock.calls.length >= 3);
    const sleep = mock(async () => {});

    await expect(
      waitForProxyReachable(8787, { attempts: 5, delayMs: 1, probe, sleep }),
    ).resolves.toBe(true);

    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("returns false when probe never becomes reachable", async () => {
    const probe = mock(async () => false);
    const sleep = mock(async () => {});

    await expect(
      waitForProxyReachable(8787, { attempts: 4, delayMs: 1, probe, sleep }),
    ).resolves.toBe(false);

    expect(probe).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});

describe("spawnProxyBackground", () => {
  test("spawns headroom proxy with only --port args and no memory flags", () => {
    let capturedCmd: string | null = null;
    let capturedArgs: string[] | null = null;
    let capturedOpts: Record<string, unknown> | null = null;
    const unreffed = { called: false };

    const mockSpawn = mock((cmd: string, args: string[], opts: Record<string, unknown>) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOpts = opts;
      return {
        unref: () => {
          unreffed.called = true;
        },
      };
    }) as unknown as typeof SpawnFn;

    spawnProxyBackground({ port: 8787 }, mockSpawn);

    expect(capturedCmd).toBe("headroom");
    expect(capturedArgs).toEqual(["proxy", "--port", "8787"]);
    expect(capturedArgs).not.toContain("--memory-db-path");
    expect(capturedArgs).not.toContain("--memory-storage");
    expect((capturedOpts as { detached: boolean }).detached).toBe(true);
    expect((capturedOpts as { env: Record<string, string> }).env.HEADROOM_OUTPUT_SHAPER).toBe("0");
    expect(unreffed.called).toBe(true);
  });

  test("captures proxy stderr for error reporting", () => {
    const mockStderr = {
      on: mock(function (
        this: typeof mockStderr,
        event: string,
        callback: (data?: unknown) => void,
      ) {
        if (event === "data") {
          callback(Buffer.from("error: port in use\n"));
          callback(Buffer.from("failed to bind\n"));
        } else if (event === "end") {
          callback();
        }
        return this;
      }),
    };

    const mockProcess = {
      stderr: mockStderr,
      unref: mock(() => {}),
    };

    const mockSpawn = mock(() => mockProcess) as unknown as typeof SpawnFn;

    spawnProxyBackground({ port: 9001 }, mockSpawn);

    const capturedErr = getProxyStderr(9001);
    expect(capturedErr).toContain("error: port in use");
    expect(capturedErr).toContain("failed to bind");
  });
});
