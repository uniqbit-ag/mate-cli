import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStudioAccess } from "./access";
import { createStudioFetch } from "./server";
import type { StudioRequestContext } from "./services";
import type { StudioApp } from "./studio-app";
import { companionDigest } from "./selection";

let root: string;
let calls: { path: string; context: StudioRequestContext }[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-studio-app-"));
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "index-Ab12.js"), "console.log(1)");
  fs.writeFileSync(path.join(root, "secret.txt"), "no");
  calls = [];
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const app = (): StudioApp => ({
  clientDir: root,
  fetch: async (request, { context }) => {
    calls.push({ path: new URL(request.url).pathname, context });
    return new Response("from the app", { status: 200 });
  },
});

function handlerFor(withApp: StudioApp | null) {
  return createStudioFetch(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: "/companions/acme", health: "ready", pairings: [] }],
      }),
    },
    { app: withApp },
  );
}

const get = (route: string) => new Request(`http://localhost${route}`);

describe("Studio's application behind the server", () => {
  test("usage is lazy, read-only and restricted to a registered digest", async () => {
    let collections = 0;
    const handler = createStudioFetch(
      {
        collectStudioInventory: async () => ({
          companions: [{ path: "/companions/acme", health: "ready", pairings: [] }],
        }),
        usage: {
          read: async () => {
            collections++;
            return {
              snapshot: null,
              error: { code: "COLLECTION_FAILED", message: "Synthetic fixture" },
            };
          },
        },
      },
      { app: app() },
    );
    await handler(get("/"));
    expect(collections).toBe(0);
    expect(handler.services.writable).toBe(false);
    await expect(handler.services.usage("/arbitrary/path", { days: 7 })).rejects.toThrow();
    expect(collections).toBe(0);
    expect(
      (await handler.services.usage(companionDigest("/companions/acme"), { days: 7 })).error?.code,
    ).toBe("COLLECTION_FAILED");
    expect(collections).toBe(1);
    await handler.close();
  });
  test("serves the application's hashed assets for a year", async () => {
    const response = await handlerFor(app())(get("/assets/index-Ab12.js"));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("console.log(1)");
    expect(response?.headers.get("cache-control")).toContain("immutable");
    expect(response?.headers.get("content-type")).toContain("javascript");
  });

  test("never maps an asset path outside the build's assets", async () => {
    for (const route of ["/assets/../secret.txt", "/assets/%2e%2e/secret.txt", "/assets/a/b.js"]) {
      const response = await handlerFor(app())(get(route));
      expect(await response?.text()).not.toBe("no");
    }
  });

  test("hands paths it does not serve to the application with the services", async () => {
    const response = await handlerFor(app())(get("/factory"));
    expect(await response?.text()).toBe("from the app");
    expect(calls.map((call) => call.path)).toEqual(["/factory"]);
    expect(typeof calls[0]!.context.studio.page).toBe("function");
  });

  test("hands the bare document address to the application", async () => {
    const response = await handlerFor(app())(get("/?companion=0123456789"));
    expect(await response?.text()).toBe("from the app");
    expect(calls.map((call) => call.path)).toEqual(["/"]);
  });

  test("names the missing build without an application, and carries no companion data", async () => {
    for (const address of ["/", "/?view=factory&companion=0123456789"]) {
      const response = await handlerFor(null)(get(address));
      const body = (await response?.text()) ?? "";
      expect(body).toContain("Studio's application build is missing.");
      expect(body).not.toContain("/companions/acme");
    }
  });

  test("answers unknown paths itself without an application", async () => {
    const response = await handlerFor(null)(get("/factory"));
    expect(response?.status).toBe(404);
  });

  test("accepts application calls only from its own page", async () => {
    const call = (origin: string) =>
      handlerFor(app())(
        new Request("http://localhost/_serverFn/abc", { method: "POST", headers: { origin } }),
      );
    expect((await call("http://evil.example"))?.status).toBe(403);
    expect((await call("http://localhost"))?.status).toBe(200);
  });

  test("answers a reading call with GET like any other read", async () => {
    const response = await handlerFor(app())(get("/_serverFn/abc?payload=x"));
    expect(response?.status).toBe(200);
    expect(calls.map((call) => call.path)).toEqual(["/_serverFn/abc"]);
  });

  test("refuses application calls when no application is installed", async () => {
    const response = await handlerFor(null)(
      new Request("http://localhost/_serverFn/abc", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    );
    expect(response?.status).toBe(405);
  });
});

describe("addresses core does not answer itself", () => {
  test("an old view address goes to the application, unredirected", async () => {
    const response = await handlerFor(app())(get("/?view=factory&companion=0123456789"));
    expect(response?.status).toBe(200);
    expect(calls.map((call) => call.path)).toEqual(["/"]);
  });

  test("the old vault reads go to the application", async () => {
    for (const route of [
      "/api/vault/tree?companion=0123456789",
      "/api/vault/file?companion=0123456789&path=note.md",
    ]) {
      expect(await (await handlerFor(app())(get(route)))?.text()).toBe("from the app");
    }
    expect(calls.map((call) => call.path)).toEqual(["/api/vault/tree", "/api/vault/file"]);
  });

  test("the old vault save reaches nothing that writes", async () => {
    const response = await handlerFor(app())(
      new Request("http://localhost/api/vault/save", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ path: "note.md", content: "two" }),
      }),
    );
    expect(response?.status).toBe(405);
    expect(calls).toEqual([]);
  });
});

describe("the application under the serve subcommand", () => {
  const guarded = () =>
    createStudioFetch(
      {
        collectStudioInventory: async () => ({ companions: [] }),
      },
      {
        app: app(),
        writable: true,
        access: createStudioAccess({
          invocation: "serve",
          terminal: false,
          hostname: "localhost",
          port: () => 80,
          token: "acme-token-0123456789abcdef",
        }),
      },
    );

  test("refuses a tokenless call and changes nothing", async () => {
    const response = await guarded()(
      new Request("http://localhost/_serverFn/abc", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    );
    expect(response?.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("refuses a tokenless read of a view", async () => {
    const response = await guarded()(get("/factory"));
    expect(response?.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("the events stream", () => {
  test("refuses a companion that is not registered", async () => {
    const response = await handlerFor(app())(get("/api/events?companion=0123456789"));
    expect(response?.status).toBe(400);
  });
});
