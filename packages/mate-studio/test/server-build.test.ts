import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  companionDigest,
  modePolicy,
  parseSelection,
  type StudioProfile,
  type StudioRequestContext,
  type StudioServices,
} from "@uniqbit/mate-core/studio";

const SERVER = path.join(import.meta.dir, "../dist/server/server.js");

/** Answers like core's services: every page selection is resolved through the profile. */
const servicesFor = (profile: StudioProfile) =>
  ({
    writable: false,
    factoryMode: true,
    modePolicy: modePolicy(profile),
    page: async (url: URL) => ({
      ...page,
      selection: parseSelection(url, modePolicy(profile)),
    }),
  }) as unknown as StudioServices;

const page = {
  inventory: {
    companions: [
      { path: "/acme-a", health: "ready", pairings: [] },
      { path: "/acme-b", health: "ready", pairings: [] },
    ],
  },
  companion: null,
  payload: null,
  error: null,
  collectedAt: null,
  writable: false,
  vault: null,
  terminal: null,
};

const services = servicesFor("standard");

async function built() {
  expect(existsSync(SERVER)).toBe(true);
  const { default: handler } = (await import(SERVER)) as {
    default: {
      fetch(request: Request, options: { context: StudioRequestContext }): Promise<Response>;
    };
  };
  return handler;
}

/** Follows the router's redirects, as a browser does, to the address finally served. */
async function follow(address: string, studio: StudioServices) {
  const handler = await built();
  let location = new URL(address, "http://127.0.0.1");
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await handler.fetch(new Request(location), { context: { studio } });
    if (response.status !== 307) return { response, location };
    location = new URL(response.headers.get("location")!, location);
  }
  throw new Error(`${address} redirects without end`);
}

describe("built server", () => {
  test("serves the document and its sidebar under Bun", async () => {
    const handler = await built();
    const response = await handler.fetch(
      new Request("http://127.0.0.1/factory?studioMode=engineering"),
      {
        context: { studio: services },
      },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Mate Studio</title>");
    // The sidebar is server-rendered with the document; views render in the browser.
    expect(html).toContain("studio-sidebar");
  });

  test("sends the route's data with the first response", async () => {
    const handler = await built();
    const response = await handler.fetch(
      new Request("http://127.0.0.1/factory?studioMode=engineering"),
      { context: { studio: services } },
    );
    expect(await response.text()).toContain("/acme-b");
  });

  test("sends a selected companion's view data with the first response", async () => {
    const companion = page.inventory.companions[0]!;
    const withCompanion = {
      ...services,
      page: async (url: URL) => ({
        ...(await services.page(url)),
        companion,
        payload: {
          companionPath: companion.path,
          changes: [],
          specs: [],
          skills: [],
          topology: null,
          worksets: [],
          linkedRepositories: [],
          worksetProblems: [],
          warnings: ["acme-view-data"],
        },
      }),
    } as unknown as StudioServices;
    const digest = companionDigest(companion.path);
    for (const view of ["workflow", "factory"]) {
      const { response } = await follow(
        `/${view}?companion=${digest}&studioMode=engineering`,
        withCompanion,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("acme-view-data");
    }
  });

  test("sends the Factory view to the Overview without the factory broker", async () => {
    const handler = await built();
    const response = await handler.fetch(
      new Request("http://127.0.0.1/factory?studioMode=engineering"),
      { context: { studio: { ...services, factoryMode: false } } },
    );
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!, "http://127.0.0.1").pathname).toBe("/");
  });

  test("names the effective mode in an address that names none or a legacy role", async () => {
    for (const [address, expected] of [
      ["/specs", "engineering"],
      ["/specs?role=business-analyst", "analysis"],
      ["/specs?studioMode=bogus&role=business-analyst", "engineering"],
      ["/specs?studioMode=analysis&role=product-engineer", "analysis"],
    ] as const) {
      const { response, location } = await follow(address, services);
      expect(response.status).toBe(200);
      expect(location.pathname).toBe("/specs");
      expect(location.searchParams.get("studioMode")).toBe(expected);
      expect(location.searchParams.has("role")).toBe(false);
    }
  });

  test("serves Analysis in the appliance whatever the address asks for", async () => {
    const appliance = servicesFor("appliance");
    for (const address of [
      "/?studioMode=engineering",
      "/workflow?studioMode=engineering",
      "/factory?role=product-engineer",
      "/skills",
    ]) {
      const { response, location } = await follow(address, appliance);
      expect(response.status).toBe(200);
      expect(location.pathname).toBe("/");
      expect(location.searchParams.get("studioMode")).toBe("analysis");
      expect(location.searchParams.has("role")).toBe(false);
    }
    const handler = await built();
    const served = await handler.fetch(new Request("http://127.0.0.1/?studioMode=analysis"), {
      context: { studio: appliance },
    });
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(html).toContain("Engineering is unavailable in the appliance.");
    expect(html).not.toMatch(/href="\/(workflow|skills|factory)/);
  });
});
