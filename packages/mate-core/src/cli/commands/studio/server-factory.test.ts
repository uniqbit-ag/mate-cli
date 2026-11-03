/** @test-requires sockets */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { brokerHandler, serveBroker } from "../../../lib/factory/broker";
import { factoryClient, type FactoryClient } from "../../../lib/factory/client";
import { CREDENTIAL_FILE, CredentialStore } from "../../../lib/factory/credential-store";
import type { WorksetRuntime } from "../../../lib/factory/runtime";
import { createStudioAccess } from "./access";
import { companionDigest } from "./selection";
import { createStudioFetch } from "./server";

let root: string;
let companion: string;
let digest: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-studio-factory-")));
  companion = path.join(root, "acme-companion");
  const working = path.join(root, "acme-web");
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.mkdirSync(working);
  execFileSync("git", ["init", "-q", working]);
  execFileSync("git", [
    "-C",
    working,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/web.git",
  ]);
  fs.writeFileSync(
    path.join(companion, ".mate", "config", "registry.yaml"),
    `repos:\n  - id: acme-web\n    path: ${working}\n`,
  );
  digest = companionDigest(companion);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function handlerFor(
  options: { writable?: boolean; token?: string; factory?: FactoryClient | null } = {},
) {
  return createStudioFetch(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: companion, health: "ready", pairings: [] }],
      }),
      factoryClient: options.factory ?? null,
    },
    {
      writable: options.writable ?? true,
      ...(options.token
        ? {
            access: createStudioAccess({
              invocation: "serve",
              terminal: false,
              hostname: "localhost",
              port: () => 80,
              token: options.token,
            }),
          }
        : {}),
    },
  );
}

/** A submitted form's fields; an absent one reads as empty, as Studio's server functions pass them. */
const form =
  (fields: Record<string, string>) =>
  (name: string): string =>
    fields[name] ?? "";

const create = (handler: ReturnType<typeof handlerFor>, fields: Record<string, string> = {}) =>
  handler.services.createOutcome(
    digest,
    form({ text: "Acme login. Engineers sign in with SSO.", start: "later", ...fields }),
  );

const record = (id = "acme-login") =>
  parse(fs.readFileSync(path.join(companion, "worksets", `${id}.yaml`), "utf8"));

const move = (handler: ReturnType<typeof handlerFor>, action: string, id = "acme-login") =>
  handler.services.worksetAction(digest, id, action, form({}));

describe("describing an outcome", () => {
  test("Save for later writes it at Clarify intent", async () => {
    const handler = handlerFor();
    await create(handler);
    const written = record();
    expect(written).toMatchObject({
      id: "acme-login",
      title: "Acme login",
      intent: "Acme login. Engineers sign in with SSO.",
      repositories: ["acme/web"],
      changes: [],
      stage: "clarify-intent",
    });
    expect(written.queuedAt).toBeUndefined();
    handler.close();
  });

  test("Start starts it at once, stamping when", async () => {
    const handler = handlerFor();
    await create(handler, { start: "start" });
    expect(typeof record().queuedAt).toBe("string");
    handler.close();
  });

  test("the same outcome twice gets the next identifier", async () => {
    const handler = handlerFor();
    await create(handler);
    await create(handler);
    expect(record("acme-login-2").title).toBe("Acme login");
    handler.close();
  });

  test("refuses a text that gives no title", async () => {
    const handler = handlerFor();
    await expect(create(handler, { text: "???" })).rejects.toThrow("gives no title");
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    handler.close();
  });

  test("refuses a repository not linked to the companion", async () => {
    const handler = handlerFor();
    await expect(create(handler, { repository: "acme/other" })).rejects.toThrow("not linked");
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    handler.close();
  });

  test("refuses a companion that is not registered", async () => {
    const handler = handlerFor();
    await expect(
      handler.services.createOutcome("0".repeat(digest.length), form({ text: "Acme login." })),
    ).rejects.toThrow("no registered companion");
    handler.close();
  });
});

describe("start and later", () => {
  test("a Later outcome starts, keeps its start time, and goes back to Later", async () => {
    const handler = handlerFor();
    await create(handler);
    await move(handler, "start");
    const queuedAt = record().queuedAt;
    expect(typeof queuedAt).toBe("string");
    await move(handler, "start");
    expect(record().queuedAt).toBe(queuedAt);
    await move(handler, "later");
    expect(record().queuedAt).toBeUndefined();
    handler.close();
  });

  test("outside factory mode, an action needing the runner is refused and changes nothing", async () => {
    const handler = handlerFor();
    await create(handler);
    const before = fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8");
    await expect(move(handler, "retry")).rejects.toThrow(
      "the AFK runner needs the appliance's factory mode for this companion",
    );
    expect(fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8")).toBe(
      before,
    );
    handler.close();
  });

  test("read-only Studio refuses to start an Outcome", async () => {
    const handler = handlerFor();
    await create(handler);
    handler.close();
    const readOnly = handlerFor({ writable: false });
    await expect(move(readOnly, "start")).rejects.toThrow("--writable");
    expect(record().queuedAt).toBeUndefined();
    readOnly.close();
  });
});

describe("the write path", () => {
  test("read-only Studio refuses to create an Outcome", async () => {
    const handler = handlerFor({ writable: false });
    await expect(create(handler)).rejects.toThrow("--writable");
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    handler.close();
  });

  test("the old form posts change nothing", async () => {
    const handler = handlerFor();
    for (const route of ["/api/factory/worksets", "/api/factory/worksets/acme-login/start"]) {
      const response = (await handler(
        new Request(`http://localhost${route}`, {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: new URLSearchParams({ companion: digest, text: "Acme login." }),
        }),
      ))!;
      expect(response.status).toBe(405);
    }
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    handler.close();
  });
});

describe("no stage is set by hand", () => {
  test("an advance request is refused and leaves the stage", async () => {
    const handler = handlerFor();
    await create(handler);
    await expect(move(handler, "advance")).rejects.toThrow();
    expect(record().stage).toBe("clarify-intent");
    handler.close();
  });
});

describe("the events stream", () => {
  /** Resolves `true` once a board event arrives, `false` after half a second without one. */
  const nextEvent = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder();
    const board = (async () => {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- reads the stream in order
        const chunk = await reader.read();
        if (chunk.done) return false;
        if (decoder.decode(chunk.value).includes('"type":"board"')) return true;
      }
    })();
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500));
    return Promise.race([board, timeout]);
  };

  test("tells an open page when an Outcome is created", async () => {
    const handler = handlerFor();
    const response = (await handler(
      new Request(`http://localhost/api/events?companion=${digest}`),
    ))!;
    const reader = response.body!.getReader();
    await reader.read(); // greeting
    const event = nextEvent(reader);
    await create(handler);
    expect(await event).toBe(true);
    await reader.cancel();
    handler.close();
  });

  test("tells it when the application starts an Outcome", async () => {
    const handler = handlerFor();
    const response = (await handler(
      new Request(`http://localhost/api/events?companion=${digest}`),
    ))!;
    const reader = response.body!.getReader();
    await reader.read();
    const event = nextEvent(reader);
    const fields: Record<string, string> = {
      text: "Acme login. Engineers sign in with SSO.",
      start: "later",
    };
    await handler.services.createOutcome(digest, (name) => fields[name] ?? "");
    expect(await event).toBe(true);
    expect(record().title).toBe("Acme login");
    await reader.cancel();
    handler.close();
  });
});

describe("the Agents panel's credential routes", () => {
  const KEY = "sk-ant-api03-acme-studio-key";
  const TOKEN = "sk-ant-oat01-acme-studio-token";
  let stopBroker: () => void = () => {};
  let store: CredentialStore;

  /** A real broker on a socket, keeping its credential in the test's directory. */
  function factory(): FactoryClient {
    const socket = path.join(root, "broker.sock");
    store = new CredentialStore(path.join(root, CREDENTIAL_FILE), null);
    stopBroker = serveBroker(socket, brokerHandler({} as WorksetRuntime, store)).stop;
    return factoryClient(socket)!;
  }

  afterEach(() => stopBroker());

  const call = (method: string, route: string, body?: unknown, headers = {}) =>
    new Request(`http://localhost${route}`, {
      method,
      headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("are not served outside factory mode", async () => {
    const handler = handlerFor();
    for (const request of [
      call("GET", "/api/factory/credential"),
      call("PUT", "/api/factory/credential", { kind: "api-key", value: KEY }),
    ]) {
      expect((await handler(request))!.status).toBe(404);
    }
    handler.close();
  });

  test("set, report and clear the credential without answering a value", async () => {
    const handler = handlerFor({ factory: factory() });
    const texts: string[] = [];
    const send = async (request: Request, status = 200) => {
      const response = (await handler(request))!;
      expect(response.status).toBe(status);
      const text = await response.text();
      texts.push(text);
      return JSON.parse(text) as Record<string, unknown>;
    };

    expect(await send(call("GET", "/api/factory/credential"))).toEqual({
      kind: null,
      source: null,
      setAt: null,
    });
    expect(
      await send(call("PUT", "/api/factory/credential", { kind: "api-key", value: KEY })),
    ).toMatchObject({ kind: "api-key", source: "studio" });
    expect(store.current()?.value).toBe(KEY);
    expect(
      (
        await send(
          call("PUT", "/api/factory/credential", { kind: "subscription", value: KEY }),
          400,
        )
      ).reason,
    ).toContain("sk-ant-oat");
    expect(await send(call("DELETE", "/api/factory/credential"))).toEqual({
      kind: null,
      source: null,
      setAt: null,
    });

    expect(
      await send(call("PUT", "/api/factory/credential", { kind: "subscription", value: TOKEN })),
    ).toMatchObject({ kind: "subscription", source: "studio" });
    expect(store.current()?.value).toBe(TOKEN);

    for (const text of texts) {
      expect(text).not.toContain("acme-studio");
    }
    handler.close();
  });

  test("HEAD answers like GET, without a body", async () => {
    const handler = handlerFor({ factory: factory() });
    const response = (await handler(call("HEAD", "/api/factory/credential")))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe("");
    handler.close();
  });

  test("writes need Studio's own page and its token", async () => {
    const handler = handlerFor({ factory: factory(), token: "acme-access" });
    const put = (headers: Record<string, string>) =>
      call("PUT", "/api/factory/credential", { kind: "api-key", value: KEY }, headers);
    const cookie = "mate_studio_80=acme-access";
    expect((await handler(put({ origin: "http://evil.test", cookie })))!.status).toBe(403);
    expect((await handler(put({})))!.status).toBe(401);
    expect((await handler(call("GET", "/api/factory/credential")))!.status).toBe(401);
    expect(store.current()).toBeNull();
    handler.close();
  });

  test("a read-only Studio cannot set the credential", async () => {
    const handler = handlerFor({ factory: factory(), writable: false });
    const response = (await handler(
      call("PUT", "/api/factory/credential", { kind: "api-key", value: KEY }),
    ))!;
    expect(response.status).toBe(403);
    expect(store.current()).toBeNull();
    handler.close();
  });
});
