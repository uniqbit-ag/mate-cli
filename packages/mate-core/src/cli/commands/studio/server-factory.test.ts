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
import { GIT_CREDENTIAL_FILE, GitCredentialStore } from "../../../lib/factory/git-credential-store";
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

const ACCESS_TOKEN = "acme-interactive-access-0123456789";
const ACCESS_COOKIE = `mate_studio_80=${ACCESS_TOKEN}`;

/** Interactive with a known token, or `serve` when the test pins its own. */
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
      access: createStudioAccess({
        invocation: options.token ? "serve" : "interactive",
        terminal: false,
        hostname: "localhost",
        port: () => 80,
        token: options.token ?? ACCESS_TOKEN,
      }),
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

  test("with Jira on, a ticket is recorded on the Workset", async () => {
    fs.writeFileSync(
      path.join(companion, ".mate", "config", "framework.yaml"),
      "type: companion\ncapabilities:\n  - name: openspec\n    ticket: jira\n",
    );
    const handler = handlerFor();
    await create(handler, { ticket: "abc-123" });
    expect(record().ticket).toBe("ABC-123");
    handler.close();
  });

  test("with tickets off, a submitted ticket is refused and nothing is written", async () => {
    const handler = handlerFor();
    await expect(create(handler, { ticket: "ABC-123" })).rejects.toThrow("ticket: jira");
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    handler.close();
  });

  test("an empty ticket field records none", async () => {
    const handler = handlerFor();
    await create(handler, { ticket: "" });
    expect(record().ticket).toBeUndefined();
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

  const owned = (method: string, route: string, body?: unknown) =>
    call(method, route, body, { cookie: ACCESS_COOKIE });

  test("are not served outside factory mode", async () => {
    const handler = handlerFor();
    for (const request of [
      owned("GET", "/api/factory/credential"),
      owned("PUT", "/api/factory/credential", { kind: "api-key", value: KEY }),
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

    expect(await send(owned("GET", "/api/factory/credential"))).toEqual({
      kind: null,
      source: null,
      setAt: null,
    });
    expect(
      await send(owned("PUT", "/api/factory/credential", { kind: "api-key", value: KEY })),
    ).toMatchObject({ kind: "api-key", source: "studio" });
    expect(store.current()?.value).toBe(KEY);
    expect(
      (
        await send(
          owned("PUT", "/api/factory/credential", { kind: "subscription", value: KEY }),
          400,
        )
      ).reason,
    ).toContain("sk-ant-oat");
    expect(await send(owned("DELETE", "/api/factory/credential"))).toEqual({
      kind: null,
      source: null,
      setAt: null,
    });

    expect(
      await send(owned("PUT", "/api/factory/credential", { kind: "subscription", value: TOKEN })),
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
      owned("PUT", "/api/factory/credential", { kind: "api-key", value: KEY }),
    ))!;
    expect(response.status).toBe(403);
    expect(store.current()).toBeNull();
    handler.close();
  });
});

describe("the Git access panel's token routes", () => {
  const SECRET = "acme-git-secret";
  let stopBroker: () => void = () => {};
  let tokens: GitCredentialStore;

  function factory(): FactoryClient {
    const socket = path.join(root, "git-broker.sock");
    tokens = new GitCredentialStore(path.join(root, GIT_CREDENTIAL_FILE), null);
    stopBroker = serveBroker(
      socket,
      brokerHandler({} as WorksetRuntime, new CredentialStore(null, null), tokens),
    ).stop;
    return factoryClient(socket)!;
  }

  afterEach(() => stopBroker());

  const call = (method: string, body?: unknown, headers = {}) =>
    new Request("http://localhost/api/factory/git-tokens", {
      method,
      headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const owned = (method: string, body?: unknown) => call(method, body, { cookie: ACCESS_COOKIE });

  test("are not served outside factory mode", async () => {
    const handler = handlerFor();
    expect((await handler(owned("GET")))!.status).toBe(404);
    expect((await handler(owned("PUT", { key: "git.acme.test", token: SECRET })))!.status).toBe(
      404,
    );
    handler.close();
  });

  test("set, list and clear keys without ever answering a token", async () => {
    const handler = handlerFor({ factory: factory() });
    const texts: string[] = [];
    const send = async (request: Request, status = 200) => {
      const response = (await handler(request))!;
      expect(response.status).toBe(status);
      const text = await response.text();
      texts.push(text);
      return JSON.parse(text) as { tokens?: { key: string; source: string }[]; reason?: string };
    };

    expect(await send(owned("GET"))).toEqual({ tokens: [] });
    expect((await send(owned("PUT", { key: "git.acme.test/acme", token: SECRET }))).tokens).toEqual(
      [expect.objectContaining({ key: "git.acme.test/acme", source: "studio" })],
    );
    expect(tokens.forUrl("https://git.acme.test/acme/web.git")).toBe(SECRET);
    expect(
      (await send(owned("PUT", { key: "a.test/one/two", token: SECRET }), 400)).reason,
    ).toMatch(/host/);
    expect(
      (await send(owned("PUT", { key: "git.acme.test", token: "has space" }), 400)).reason,
    ).toMatch(/Git token/);
    expect((await send(owned("DELETE", { key: "git.acme.test/acme" }))).tokens).toEqual([]);

    for (const text of texts) expect(text).not.toContain("acme-git");
    handler.close();
  });

  test("a read-only Studio cannot set a token, and writes need Studio's own page and token", async () => {
    const readOnly = handlerFor({ factory: factory(), writable: false });
    expect((await readOnly(owned("PUT", { key: "git.acme.test", token: SECRET })))!.status).toBe(
      403,
    );
    readOnly.close();
    stopBroker();

    const guarded = handlerFor({ factory: factory(), token: "acme-access" });
    const put = (headers: Record<string, string>) =>
      call("PUT", { key: "git.acme.test", token: SECRET }, headers);
    const cookie = "mate_studio_80=acme-access";
    expect((await guarded(put({ origin: "http://evil.test", cookie })))!.status).toBe(403);
    expect((await guarded(put({})))!.status).toBe(401);
    expect((await guarded(call("GET")))!.status).toBe(401);
    expect(tokens.status()).toEqual([]);
    guarded.close();
  });
});

describe("adding a companion", () => {
  let stopBroker: () => void = () => {};
  afterEach(() => stopBroker());

  /** A broker whose runtime clones into `root/companions`, as the factory's would. */
  function factory(clone: (url: string) => Promise<{ path: string; existing: boolean }>) {
    const socket = path.join(root, "add-broker.sock");
    const runtime = { cloneCompanion: clone } as unknown as WorksetRuntime;
    stopBroker = serveBroker(socket, brokerHandler(runtime, new CredentialStore(null, null))).stop;
    return factoryClient(socket)!;
  }

  const URL = "https://git.acme.test/acme/acme-companion.git";

  test("is refused without the write path or outside factory mode, and nothing is cloned", async () => {
    const cloned: string[] = [];
    const client = factory(async (url) => (cloned.push(url), { path: "/x", existing: false }));
    const readOnly = handlerFor({ factory: client, writable: false });
    expect(await readOnly.services.addCompanion({ kind: "url", url: URL })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--writable"),
    });
    readOnly.close();
    const plain = handlerFor({ factory: null });
    expect(await plain.services.addCompanion({ kind: "url", url: URL })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("factory"),
    });
    plain.close();
    expect(cloned).toEqual([]);
  });

  test("a refused clone is an answer that names the Git token to set", async () => {
    const { FactoryError } = await import("../../../lib/factory/ids");
    const handler = handlerFor({
      factory: factory(async () => {
        throw new FactoryError(
          "cloning acme/acme-companion failed: authentication to git.acme.test/acme failed",
          "auth",
        );
      }),
    });
    expect(await handler.services.addCompanion({ kind: "url", url: URL })).toEqual({
      ok: false,
      reason: expect.stringContaining("authentication"),
      tokenKey: "git.acme.test/acme",
    });
    handler.close();
  });

  test("a folder that is not a companion is refused by path", async () => {
    const handler = handlerFor({ factory: factory(async () => ({ path: "/x", existing: false })) });
    const bare = path.join(root, "bare");
    fs.mkdirSync(bare);
    expect(await handler.services.addCompanion({ kind: "path", path: bare })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("nothing to register"),
    });
    expect(fs.readdirSync(bare)).toEqual([]);
    handler.close();
  });
});

describe("adding a repository", () => {
  let stopBroker: () => void = () => {};
  afterEach(() => stopBroker());

  const WEB = "https://git.acme.test/acme/docs.git";
  const file = () => path.join(companion, "factory.local.yaml");

  /** A broker whose runtime answers the reachability check as `check` says. */
  function factory(check: (url: string) => Promise<void>) {
    const socket = path.join(root, "repo-broker.sock");
    const runtime = { checkRemote: check } as unknown as WorksetRuntime;
    stopBroker = serveBroker(socket, brokerHandler(runtime, new CredentialStore(null, null))).stop;
    return factoryClient(socket)!;
  }

  test("is refused without the write path or outside factory mode, and nothing is checked or written", async () => {
    const checked: string[] = [];
    const client = factory(async (url) => void checked.push(url));
    const readOnly = handlerFor({ factory: client, writable: false });
    expect(await readOnly.services.addRepository(digest, { kind: "url", url: WEB })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("--writable"),
    });
    expect(await readOnly.services.removeRepository(digest, "acme/docs")).toMatchObject({
      ok: false,
    });
    readOnly.close();
    const plain = handlerFor({ factory: null });
    expect(await plain.services.addRepository(digest, { kind: "url", url: WEB })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("factory"),
    });
    plain.close();
    expect(checked).toEqual([]);
    expect(fs.existsSync(file())).toBe(false);
  });

  test("checks the remote through the broker, lists it, and the board offers it from the list", async () => {
    const checked: string[] = [];
    const handler = handlerFor({ factory: factory(async (url) => void checked.push(url)) });
    expect(await handler.services.addRepository(digest, { kind: "url", url: WEB })).toEqual({
      ok: true,
      identity: "acme/docs",
      existing: false,
    });
    expect(checked).toEqual([WEB]);
    expect(parse(fs.readFileSync(file(), "utf8"))).toEqual({ repositories: [WEB] });
    const page = await handler.services.page(
      new URL(`http://localhost/?companion=${digest}&view=factory`),
    );
    expect(page.payload?.linkedRepositories).toContain("acme/docs");
    expect(page.payload?.repositorySources).toMatchObject({ "acme/docs": "list" });
    handler.close();
  });

  test("an unreachable remote and an authentication refusal add nothing", async () => {
    const { FactoryError } = await import("../../../lib/factory/ids");
    let refusal: Error = new FactoryError("reaching acme/docs failed: repository not found");
    const handler = handlerFor({
      factory: factory(async () => {
        throw refusal;
      }),
    });
    expect(await handler.services.addRepository(digest, { kind: "url", url: WEB })).toEqual({
      ok: false,
      reason: expect.stringContaining("not found"),
    });
    refusal = new FactoryError("authentication to git.acme.test/acme failed", "auth");
    expect(await handler.services.addRepository(digest, { kind: "url", url: WEB })).toMatchObject({
      ok: false,
      tokenKey: "git.acme.test/acme",
    });
    expect(fs.existsSync(file())).toBe(false);
    handler.close();
  });

  test("removes a listed repository, and refuses one the list does not hold", async () => {
    const handler = handlerFor({ factory: factory(async () => {}) });
    await handler.services.addRepository(digest, { kind: "url", url: WEB });
    expect(await handler.services.removeRepository(digest, "acme/docs")).toEqual({ ok: true });
    expect(await handler.services.removeRepository(digest, "acme/docs")).toMatchObject({
      ok: false,
    });
    expect(parse(fs.readFileSync(file(), "utf8"))).toEqual({ repositories: [] });
    handler.close();
  });
});

describe("Studio modes in the factory", () => {
  let stopBroker: () => void = () => {};
  afterEach(() => stopBroker());

  function broker(): FactoryClient {
    const socket = path.join(root, "modes-broker.sock");
    const store = new CredentialStore(path.join(root, CREDENTIAL_FILE), null);
    stopBroker = serveBroker(socket, brokerHandler({} as WorksetRuntime, store)).stop;
    return factoryClient(socket)!;
  }

  test("default to Engineering with both modes enabled, broker on or off", async () => {
    for (const factory of [broker(), null]) {
      const handler = handlerFor({ factory });
      expect(handler.services.factoryMode).toBe(factory !== null);
      expect(handler.services.modePolicy).toMatchObject({
        profile: "standard",
        enabled: ["engineering", "analysis"],
        defaultMode: "engineering",
      });
      const page = await handler.services.page(new URL(`http://localhost/?companion=${digest}`));
      expect(page.selection.studioMode).toBe("engineering");
      const factoryView = await handler.services.page(
        new URL(`http://localhost/?companion=${digest}&view=factory`),
      );
      expect(factoryView.selection.view).toBe("factory");
      await handler.close();
    }
  });

  test("serve an explicit Analysis selection without stopping the broker", async () => {
    const handler = handlerFor({ factory: broker() });
    const page = await handler.services.page(
      new URL(`http://localhost/?companion=${digest}&studioMode=analysis&view=factory`),
    );
    expect(page.selection).toMatchObject({ studioMode: "analysis", view: "dashboard" });
    expect(handler.services.factoryMode).toBe(true);
    await handler.close();
  });
});
