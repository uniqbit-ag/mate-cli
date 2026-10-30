import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { brokerHandler, serveBroker } from "./broker";
import { factoryClient } from "./client";
import type { WorksetRuntime } from "./runtime";

let stop: (() => void) | null = null;
let dir: string | null = null;

afterEach(() => {
  stop?.();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  stop = dir = null;
});

describe("the factory client", () => {
  test("is absent outside factory mode", () => {
    expect(factoryClient(undefined)).toBeNull();
  });

  test("talks to the broker over its Unix socket and surfaces refusals", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-broker-"));
    const socket = path.join(dir, "broker.sock");
    const runtime = {
      list: async () => [
        { id: "acme-login", repository: "acme/app", branch: "change/acme-login", state: "paused" },
      ],
    } as unknown as WorksetRuntime;
    stop = serveBroker(socket, brokerHandler(runtime, null)).stop;

    const client = factoryClient(socket)!;
    expect(await client.list()).toEqual([
      { id: "acme-login", repository: "acme/app", branch: "change/acme-login", state: "paused" },
    ]);
    await expect(
      client.exec({ id: "acme-login", command: ["claude"], agent: true }),
    ).rejects.toThrow(/no Workset agent credential/);
  });

  test("names an unreachable broker", async () => {
    await expect(factoryClient("/nonexistent/broker.sock")!.list()).rejects.toThrow(
      /not reachable/,
    );
  });
});
