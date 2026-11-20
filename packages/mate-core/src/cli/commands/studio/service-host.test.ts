import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  PluginService,
  StudioServiceHost,
  StudioSocketHandler,
} from "../../../tools/setup/service";
import { createStudioAccess } from "./access";
import { companionDigest } from "./selection";
import { createStudioFetch, type StudioUpgrader } from "./server";

let root: string;
let companion: string;
let viewDir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-studio-services-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(companion);
  viewDir = path.join(root, "view");
  fs.mkdirSync(viewDir);
  fs.writeFileSync(path.join(viewDir, "view.js"), "export function mount() { return () => {}; }");
  fs.writeFileSync(path.join(root, "secret.txt"), "acme secret");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const TOKEN = "acme-services-access-0123456789";
const COOKIE = `mate_studio_80=${TOKEN}`;

interface Recorded {
  host?: StudioServiceHost;
  calls: string[];
  socket: string[];
}

function acmeService(recorded: Recorded, overrides: Partial<PluginService> = {}): PluginService {
  return {
    apiVersion: 1,
    id: "acme",
    label: "Acme",
    connection: (env) => (env.ACME_SOCKET ? { kind: "socket", path: env.ACME_SOCKET } : null),
    studio: (host) => {
      recorded.host = host;
      return {
        routes: [
          {
            path: "/status",
            methods: {
              GET: { kind: "read" },
              PUT: { kind: "write", writable: "start Studio with --writable to change acme" },
            },
            handle: async (request, context) => {
              recorded.calls.push(`${request.method} ${context.path}`);
              return Response.json({ path: context.path });
            },
          },
          {
            path: "/items/*",
            methods: { GET: { kind: "read" } },
            handle: async (_request, context) => Response.json({ path: context.path }),
          },
          {
            path: "/live",
            methods: { GET: { kind: "socket" } },
            socket: (): StudioSocketHandler => ({
              open: () => void recorded.socket.push("open"),
              message: (data) => void recorded.socket.push(String(data)),
              close: () => void recorded.socket.push("close"),
            }),
          },
        ],
        views: [
          { id: "board", label: "Acme board", module: { dir: viewDir, entry: "view.js" } },
          { id: "plain", label: "Plain" },
        ],
        pinnedCompanions: [companion],
      };
    },
    ...overrides,
  };
}

function handlerFor(
  services: PluginService[],
  options: { writable?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  return createStudioFetch(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: companion, health: "ready", pairings: [] }],
      }),
      services,
      env: options.env ?? { ACME_SOCKET: path.join(root, "acme.sock") },
    },
    {
      writable: options.writable ?? true,
      access: createStudioAccess({
        invocation: "interactive",
        terminal: false,
        hostname: "localhost",
        port: () => 80,
        token: TOKEN,
      }),
    },
  );
}

const request = (method: string, route: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${route}`, {
    method,
    headers: { origin: "http://localhost", cookie: COOKIE, ...headers },
  });

describe("mounting services in Studio", () => {
  test("hands the host its connection and lists the service with its views", async () => {
    const recorded: Recorded = { calls: [], socket: [] };
    const handler = handlerFor([acmeService(recorded)]);
    await handler.ready;
    expect(recorded.host).toMatchObject({
      apiVersion: 1,
      connection: { kind: "socket", path: path.join(root, "acme.sock") },
      writable: true,
      launchCompanion: null,
    });
    expect(await recorded.host!.companionPath(companionDigest(companion))).toBe(companion);
    await expect(recorded.host!.companionPath("0".repeat(16))).rejects.toThrow(
      "no registered companion",
    );
    expect(await recorded.host!.launchTarget(companionDigest(companion))).toBe(companion);
    expect(recorded.host!.terminal.enabled).toBe(false);
    expect(handler.services.services()).toEqual([
      {
        id: "acme",
        label: "Acme",
        views: [
          { id: "board", label: "Acme board", moduleUrl: "/studio/plugins/acme/board/view.js" },
          { id: "plain", label: "Plain" },
        ],
      },
    ]);
    await handler.close();
  });

  test("leaves out a service whose daemon is not there, and one that fails to start", async () => {
    const recorded: Recorded = { calls: [], socket: [] };
    const absent = handlerFor([acmeService(recorded)], { env: {} });
    await absent.ready;
    expect(absent.services.services()).toEqual([]);
    expect(recorded.host).toBeUndefined();
    await absent.close();

    const failing = handlerFor([
      acmeService(recorded, {
        studio: () => {
          throw new Error("acme broke");
        },
      }),
    ]);
    await failing.ready;
    expect(failing.services.services()).toEqual([]);
    expect((await failing(request("GET", "/api/plugins/acme/status")))!.status).toBe(404);
    await failing.close();
  });
});

describe("service routes", () => {
  test("serve reads and writes below the service prefix, HEAD following GET", async () => {
    const recorded: Recorded = { calls: [], socket: [] };
    const handler = handlerFor([acmeService(recorded)]);
    const read = (await handler(request("GET", "/api/plugins/acme/status")))!;
    expect(await read.json()).toEqual({ path: "/status" });
    expect((await handler(request("HEAD", "/api/plugins/acme/status")))!.status).toBe(200);
    expect((await handler(request("PUT", "/api/plugins/acme/status")))!.status).toBe(200);
    const deep = (await handler(request("GET", "/api/plugins/acme/items/a/b")))!;
    expect(await deep.json()).toEqual({ path: "/items/a/b" });
    expect(recorded.calls).toEqual(["GET /status", "HEAD /status", "PUT /status"]);
    await handler.close();
  });

  test("guard writes by origin, token and the write path before the route runs", async () => {
    const recorded: Recorded = { calls: [], socket: [] };
    const handler = handlerFor([acmeService(recorded)]);
    const foreign = (await handler(
      request("PUT", "/api/plugins/acme/status", { origin: "https://evil.test" }),
    ))!;
    expect(foreign.status).toBe(403);
    const tokenless = (await handler(
      new Request("http://localhost/api/plugins/acme/status", {
        method: "PUT",
        headers: { origin: "http://localhost" },
      }),
    ))!;
    expect(tokenless.status).toBe(401);
    await handler.close();

    const readOnly = handlerFor([acmeService(recorded)], { writable: false });
    const refused = (await readOnly(request("PUT", "/api/plugins/acme/status")))!;
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("start Studio with --writable to change acme");
    const called = await readOnly.services.callService(
      new Request("http://localhost/api/plugins/acme/status", { method: "PUT" }),
    );
    expect(called.status).toBe(403);
    expect(recorded.calls).toEqual([]);
    await readOnly.close();
  });

  test("answer 405 for a method the route does not serve, and 404 for an unknown route", async () => {
    const recorded: Recorded = { calls: [], socket: [] };
    const handler = handlerFor([acmeService(recorded)]);
    const wrong = (await handler(request("DELETE", "/api/plugins/acme/status")))!;
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET, PUT, HEAD");
    expect((await handler(request("GET", "/api/plugins/acme/other")))!.status).toBe(404);
    expect((await handler(request("POST", "/api/plugins/other/status")))!.status).toBe(404);
    await handler.close();
  });

  test("upgrade a socket route and hand the connection to the service", async () => {
    const recorded: Recorded = { calls: [], socket: [] };
    const handler = handlerFor([acmeService(recorded)]);
    const upgraded: unknown[] = [];
    const server: StudioUpgrader = {
      upgrade: (_request, options) => {
        upgraded.push(options.data);
        return true;
      },
    };
    const plain = (await handler(request("GET", "/api/plugins/acme/live"), server))!;
    expect(plain.status).toBe(426);
    const answer = await handler(
      request("GET", "/api/plugins/acme/live", { upgrade: "websocket" }),
      server,
    );
    expect(answer).toBeUndefined();
    const data = upgraded[0] as { service: StudioSocketHandler };
    data.service.open({ send: () => {}, close: () => {} });
    data.service.message("ping");
    expect(recorded.socket).toEqual(["open", "ping"]);
    const foreign = (await handler(
      request("GET", "/api/plugins/acme/live", {
        upgrade: "websocket",
        origin: "https://evil.test",
      }),
      server,
    ))!;
    expect(foreign.status).toBe(403);
    await handler.close();
  });
});

describe("view modules", () => {
  test("serve the view's files and nothing outside its folder", async () => {
    const handler = handlerFor([acmeService({ calls: [], socket: [] })]);
    const file = (await handler(request("GET", "/studio/plugins/acme/board/view.js")))!;
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("text/javascript");
    expect(await file.text()).toContain("mount");
    for (const route of [
      "/studio/plugins/acme/board/../secret.txt",
      "/studio/plugins/acme/board/%2e%2e/secret.txt",
      "/studio/plugins/acme/plain/view.js",
      "/studio/plugins/acme/board/missing.js",
      "/studio/plugins/other/board/view.js",
    ]) {
      const response = (await handler(request("GET", route)))!;
      expect({ route, status: response.status }).toEqual({ route, status: 404 });
    }
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(viewDir, "link.txt"));
    expect((await handler(request("GET", "/studio/plugins/acme/board/link.txt")))!.status).toBe(
      404,
    );
    await handler.close();
  });
});

describe("companions a service pins or provides", () => {
  test("a pinned companion is not deleted", async () => {
    const handler = handlerFor([acmeService({ calls: [], socket: [] })]);
    await expect(handler.services.deleteCompanion(companionDigest(companion))).rejects.toThrow(
      "Studio was started for this companion",
    );
    expect(fs.existsSync(companion)).toBe(true);
    await handler.close();
  });

  test("adding a companion needs a service that provides them", async () => {
    const handler = handlerFor([]);
    expect(
      await handler.services.addCompanion({ kind: "url", url: "https://acme.test/c.git" }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("service") });
    await handler.close();
  });

  test("a service's folder decides which companions only leave the list", async () => {
    const recorded: Recorded = { calls: [], socket: [] };
    const service = acmeService(recorded);
    const studio = service.studio!;
    service.studio = async (host) => ({
      ...(await studio(host)),
      companions: {
        folder: path.join(root, "fetched"),
        addByUrl: async () => ({ ok: false, reason: "offline" }),
      },
    });
    const handler = handlerFor([service]);
    await handler.ready;
    expect(handler.services.keepsFolder(companion)).toBe(true);
    expect(handler.services.keepsFolder(path.join(root, "fetched", "acme"))).toBe(false);
    expect(
      await handler.services.addCompanion({ kind: "url", url: "https://acme.test/c.git" }),
    ).toEqual({ ok: false, reason: "offline" });
    await handler.close();
  });
});
