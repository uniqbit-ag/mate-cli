import { describe, expect, test } from "bun:test";

import { companionDigest } from "./selection";
import {
  createStudioFetch,
  serveUntilInterrupted,
  startStudioServer,
  type StudioServerDeps,
} from "./server";
import type { StudioPage } from "./views/model";

const ACME = "/companions/acme";
const BROKEN = "/companions/broken";

function deps(overrides: Partial<StudioServerDeps> = {}): StudioServerDeps {
  return {
    collectStudioInventory: async () => ({
      companions: [
        { path: ACME, health: "ready", pairings: [] },
        { path: BROKEN, health: "ready", pairings: [] },
      ],
    }),
    assembleCompanionPayload: async (companionPath) => ({
      companionPath,
      changes: [],
      specs: [],
      topology: null,
      warnings: [],
    }),
    renderDocument: () => "<!doctype html><title>Studio</title>",
    ...overrides,
  };
}

/** Captures the state the document was rendered from, so the URL is what is asserted. */
function capturing(overrides: Partial<StudioServerDeps> = {}) {
  const pages: StudioPage[] = [];
  const assembled: string[] = [];
  const handler = createStudioFetch(
    deps({
      assembleCompanionPayload: async (companionPath) => {
        assembled.push(companionPath);
        if (companionPath === BROKEN) throw new Error("unreadable");
        return {
          companionPath,
          changes: [{ name: "add-auth", completedTasks: 1, totalTasks: 2, artifacts: [] }],
          specs: [],
          topology: null,
          warnings: [],
        };
      },
      renderDocument: (page) => {
        pages.push(page);
        return "<!doctype html><title>Studio</title>";
      },
      ...overrides,
    }),
  );
  return { handler, pages, assembled };
}

describe("createStudioFetch", () => {
  test("serves the document at the root", async () => {
    const response = await createStudioFetch(deps())(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("<!doctype html>");
  });

  test("renders the state the URL names", async () => {
    const { handler, pages, assembled } = capturing();
    const digest = companionDigest(ACME);

    const response = await handler(
      new Request(`http://localhost/?companion=${digest}&change=add-auth&view=workflow`),
    );

    expect(response.status).toBe(200);
    expect(assembled).toEqual([ACME]);
    expect(pages[0]?.selection).toEqual({
      companionDigest: digest,
      view: "workflow",
      refresh: false,
    });
    expect(pages[0]?.companion?.path).toBe(ACME);
    expect(pages[0]?.payload?.companionPath).toBe(ACME);
  });

  test("assembles nothing when no companion is named", async () => {
    const { handler, pages, assembled } = capturing();

    const response = await handler(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(assembled).toEqual([]);
    expect(pages[0]?.companion).toBeNull();
    expect(pages[0]?.payload).toBeNull();
    expect(pages[0]?.inventory.companions).toHaveLength(2);
  });

  test("falls back to the selector for an unresolvable companion", async () => {
    const { handler, pages, assembled } = capturing();

    const response = await handler(new Request("http://localhost/?companion=deadbeef00"));

    expect(response.status).toBe(200);
    expect(assembled).toEqual([]);
    expect(pages[0]?.companion).toBeNull();
    expect(pages[0]?.error).toBeNull();
  });

  test("renders an error payload rather than failing the request", async () => {
    const { handler, pages } = capturing({
      assembleCompanionPayload: async (companionPath) => ({
        error: { companionPath, reason: "openspec list --json: exit code 1" },
      }),
    });

    const response = await handler(
      new Request(`http://localhost/?companion=${companionDigest(ACME)}`),
    );

    expect(response.status).toBe(200);
    expect(pages[0]?.error).toEqual({
      companionPath: ACME,
      reason: "openspec list --json: exit code 1",
    });
    expect(pages[0]?.payload).toBeNull();
  });

  test("keeps serving after one companion throws, and every other stays reachable", async () => {
    const { handler, pages } = capturing();

    const failed = await handler(
      new Request(`http://localhost/?companion=${companionDigest(BROKEN)}`),
    );
    expect(failed.status).toBe(200);
    expect(pages[0]?.error).toEqual({ companionPath: BROKEN, reason: "unreadable" });
    expect(pages[0]?.inventory.companions).toHaveLength(2);

    const next = await handler(new Request(`http://localhost/?companion=${companionDigest(ACME)}`));
    expect(next.status).toBe(200);
    expect(pages[1]?.payload?.companionPath).toBe(ACME);
  });

  test("switching a view serves the collected snapshot rather than collecting again", async () => {
    const { handler, pages, assembled } = capturing();
    const digest = companionDigest(ACME);

    await handler(new Request(`http://localhost/?companion=${digest}`));
    await handler(new Request(`http://localhost/?companion=${digest}&view=workflow`));
    await handler(new Request(`http://localhost/?companion=${digest}&view=dashboard`));

    expect(assembled).toEqual([ACME]);
    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.selection.view)).toEqual([
      "dashboard",
      "workflow",
      "dashboard",
    ]);
    expect(new Set(pages.map((page) => page.collectedAt))).toHaveLength(1);
    expect(pages[1]?.payload?.companionPath).toBe(ACME);
  });

  test("a refresh collects again", async () => {
    const { handler, assembled } = capturing();
    const digest = companionDigest(ACME);

    await handler(new Request(`http://localhost/?companion=${digest}`));
    await handler(new Request(`http://localhost/?companion=${digest}&refresh=1`));

    expect(assembled).toEqual([ACME, ACME]);
  });

  test("each companion holds its own snapshot", async () => {
    const collected: string[] = [];
    const handler = createStudioFetch(
      deps({
        assembleCompanionPayload: async (companionPath) => {
          collected.push(companionPath);
          return { companionPath, changes: [], specs: [], topology: null, warnings: [] };
        },
      }),
    );

    await handler(new Request(`http://localhost/?companion=${companionDigest(ACME)}`));
    await handler(new Request(`http://localhost/?companion=${companionDigest(BROKEN)}`));
    await handler(new Request(`http://localhost/?companion=${companionDigest(ACME)}`));

    expect(collected).toEqual([ACME, BROKEN]);
  });

  test("a companion whose collection threw is collected again on the next request", async () => {
    const { handler, assembled } = capturing();
    const digest = companionDigest(BROKEN);

    await handler(new Request(`http://localhost/?companion=${digest}`));
    await handler(new Request(`http://localhost/?companion=${digest}`));

    expect(assembled).toEqual([BROKEN, BROKEN]);
  });

  test("renders the document from the real views for a named companion", async () => {
    const handler = createStudioFetch({
      collectStudioInventory: async () => ({
        companions: [{ path: ACME, health: "ready", pairings: [] }],
      }),
      assembleCompanionPayload: async (companionPath) => ({
        companionPath,
        changes: [{ name: "add-auth", completedTasks: 1, totalTasks: 2, artifacts: [] }],
        specs: [],
        topology: null,
        warnings: [],
      }),
    });

    const body = await (
      await handler(new Request(`http://localhost/?companion=${companionDigest(ACME)}`))
    ).text();

    expect(body).toContain("<!doctype html>");
    expect(body).toContain("add-auth");
    expect(body).toContain("<h3>Changes</h3>");
  });

  test.each(["/api/inventory", "/api/companion", "/api/companion?path=/companions/acme"])(
    "answers %s as unrouted rather than serving its old payload",
    async (route) => {
      const { handler, assembled } = capturing();

      const response = await handler(new Request(`http://localhost${route}`));

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type") ?? "").not.toContain("application/json");
      expect(await response.text()).toBe("not found");
      expect(assembled).toEqual([]);
    },
  );

  test("answers an unknown path with 404", async () => {
    const response = await createStudioFetch(deps())(new Request("http://localhost/nope"));

    expect(response.status).toBe(404);
  });

  test.each(["POST", "PUT", "PATCH", "DELETE"])("refuses %s requests", async (method) => {
    const collected: string[] = [];
    const handler = createStudioFetch(
      deps({
        collectStudioInventory: async () => {
          collected.push("inventory");
          return { companions: [] };
        },
      }),
    );

    const response = await handler(new Request("http://localhost/", { method }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(collected).toEqual([]);
  });

  test("serves a HEAD request without a body", async () => {
    const response = await createStudioFetch(deps())(
      new Request("http://localhost/", { method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("startStudioServer", () => {
  test("binds an operating-system-assigned loopback port and reports its URL", async () => {
    const server = startStudioServer(deps());

    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toBe(`http://localhost:${server.port}`);
      expect(server.hostname).toBe("127.0.0.1");

      const document = await fetch(server.url);
      expect(await document.text()).toContain("<!doctype html>");
    } finally {
      await server.stop();
    }
  });

  test("two servers coexist on their own assigned ports", async () => {
    const first = startStudioServer(deps());
    const second = startStudioServer(deps());

    try {
      expect(first.port).not.toBe(second.port);
      expect((await fetch(second.url)).status).toBe(200);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  test("stops accepting connections once stopped", async () => {
    const server = startStudioServer(deps());
    const url = server.url;
    await server.stop();

    await expect(fetch(url)).rejects.toThrow();
  });

  test("reports a bind failure as a thrown error", () => {
    expect(() =>
      startStudioServer({
        ...deps(),
        serve: () => {
          throw new Error("EADDRINUSE");
        },
      }),
    ).toThrow("EADDRINUSE");
  });
});

describe("serveUntilInterrupted", () => {
  test("stops the server on an interrupt and leaves no signal handler behind", async () => {
    let stopped = false;
    const listeners: Record<string, () => void> = {};
    const before = process.listenerCount("SIGINT");

    const pending = serveUntilInterrupted(
      {
        url: "http://localhost:1234",
        port: 1234,
        hostname: "127.0.0.1",
        stop: () => {
          stopped = true;
        },
      },
      {
        onSignal: (signal, handler) => {
          listeners[signal] = handler;
          return () => {
            delete listeners[signal];
          };
        },
      },
    );

    expect(Object.keys(listeners)).toEqual(["SIGINT", "SIGTERM"]);
    listeners.SIGINT?.();
    await pending;

    expect(stopped).toBe(true);
    expect(Object.keys(listeners)).toEqual([]);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
