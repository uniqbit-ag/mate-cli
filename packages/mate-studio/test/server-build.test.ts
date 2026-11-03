import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import type { StudioRequestContext, StudioServices } from "@uniqbit/mate-core/studio";

const SERVER = path.join(import.meta.dir, "../dist/server/server.js");

const services = {
  writable: false,
  factoryMode: true,
  page: async () => ({
    inventory: {
      companions: [
        { path: "/acme-a", health: "ready", pairings: [] },
        { path: "/acme-b", health: "ready", pairings: [] },
      ],
    },
    selection: {
      role: "product-engineer",
      view: "dashboard",
      companionDigest: null,
      refresh: false,
    },
    companion: null,
    payload: null,
    error: null,
    collectedAt: null,
    writable: false,
    vault: null,
    terminal: null,
  }),
} as unknown as StudioServices;

async function built() {
  expect(existsSync(SERVER)).toBe(true);
  const { default: handler } = (await import(SERVER)) as {
    default: {
      fetch(request: Request, options: { context: StudioRequestContext }): Promise<Response>;
    };
  };
  return handler;
}

describe("built server", () => {
  test("serves the document and its sidebar under Bun", async () => {
    const handler = await built();
    const response = await handler.fetch(new Request("http://127.0.0.1/factory"), {
      context: { studio: services },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Mate Studio</title>");
    // The sidebar is server-rendered with the document; views render in the browser.
    expect(html).toContain("studio-sidebar");
  });

  test("sends the route's data with the first response", async () => {
    const handler = await built();
    const response = await handler.fetch(new Request("http://127.0.0.1/factory"), {
      context: { studio: services },
    });
    expect(await response.text()).toContain("/acme-b");
  });

  test("sends the Factory view to the Overview without the factory broker", async () => {
    const handler = await built();
    const response = await handler.fetch(new Request("http://127.0.0.1/factory"), {
      context: { studio: { ...services, factoryMode: false } },
    });
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!, "http://127.0.0.1").pathname).toBe("/");
  });
});
