import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { brokerHandler, serveBroker } from "./broker";
import { factoryClient } from "./client";
import { CREDENTIAL_FILE, CredentialStore } from "./credential-store";
import { GIT_CREDENTIAL_FILE, GitCredentialStore } from "./git-credential-store";
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
        { id: "acme-login", repository: "acme/app", branch: "workset/acme-login", state: "paused" },
      ],
    } as unknown as WorksetRuntime;
    stop = serveBroker(socket, brokerHandler(runtime, new CredentialStore(null, null))).stop;

    const client = factoryClient(socket)!;
    expect(await client.list()).toEqual([
      { id: "acme-login", repository: "acme/app", branch: "workset/acme-login", state: "paused" },
    ]);
    await expect(
      client.exec({ id: "acme-login", command: ["claude"], agent: true }),
    ).rejects.toThrow(/no Workset agent credential/);
  });

  test("sets, lists and clears Git tokens through the broker and never gets one back", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-broker-"));
    const socket = path.join(dir, "broker.sock");
    const tokens = new GitCredentialStore(path.join(dir, GIT_CREDENTIAL_FILE), null);
    stop = serveBroker(
      socket,
      brokerHandler({} as WorksetRuntime, new CredentialStore(null, null), tokens),
    ).stop;
    const client = factoryClient(socket)!;
    await client.gitToken.set("git.acme.test/acme", "acme-token");
    const listed = await client.gitToken.list();
    expect(listed).toMatchObject([{ key: "git.acme.test/acme", source: "studio" }]);
    expect(JSON.stringify(listed)).not.toContain("acme-token");
    await client.gitToken.clear("git.acme.test/acme");
    expect(await client.gitToken.list()).toEqual([]);
  });

  test("carries an authentication refusal's code to the caller", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-broker-"));
    const socket = path.join(dir, "broker.sock");
    const { FactoryError } = await import("./ids");
    const runtime = {
      spawn: async () => {
        throw new FactoryError(
          "cloning acme/app failed: authentication to git.acme.test/acme failed",
          "auth",
        );
      },
    } as unknown as WorksetRuntime;
    stop = serveBroker(socket, brokerHandler(runtime, new CredentialStore(null, null))).stop;
    const error = await factoryClient(socket)!
      .spawn({ id: "acme-login", repository: "acme/app", remoteUrl: "x", companion: "/c" })
      .catch((caught) => caught as { code?: string });
    expect(error.code).toBe("auth");
  });

  test("carries a busy refusal's code to the caller", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-broker-"));
    const socket = path.join(dir, "broker.sock");
    const { FactoryError } = await import("./ids");
    const runtime = {
      spawn: async () => {
        throw new FactoryError("all 4 running Workset containers are busy", "busy");
      },
    } as unknown as WorksetRuntime;
    stop = serveBroker(socket, brokerHandler(runtime, new CredentialStore(null, null))).stop;
    const refused = factoryClient(socket)!.spawn({
      id: "acme-login",
      repository: "acme/app",
      remoteUrl: "https://git.acme.test/acme/app.git",
      companion: "/companions/acme",
    });
    await expect(refused).rejects.toThrow(/busy/);
    await refused.catch((error: { code?: string }) => expect(error.code).toBe("busy"));
  });

  test("sets, reports and clears the agent credential", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-broker-"));
    const socket = path.join(dir, "broker.sock");
    const store = new CredentialStore(path.join(dir, CREDENTIAL_FILE), null);
    stop = serveBroker(socket, brokerHandler({} as WorksetRuntime, store)).stop;
    const client = factoryClient(socket)!;

    await client.credential.set("api-key", "sk-ant-api03-acme-key");
    expect(await client.info()).toEqual({ credential: "api-key" });
    expect(await client.credential.status()).toMatchObject({ kind: "api-key", source: "studio" });
    await expect(client.credential.set("subscription", "acme")).rejects.toThrow(/sk-ant-oat/);
    await client.credential.clear();
    expect(await client.credential.status()).toEqual({ kind: null, source: null, setAt: null });
  });

  test("names an unreachable broker", async () => {
    await expect(factoryClient("/nonexistent/broker.sock")!.list()).rejects.toThrow(
      /not reachable/,
    );
  });
});
