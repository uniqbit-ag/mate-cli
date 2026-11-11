import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    keepsFolder: () => false,
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
const acme = page.inventory.companions[0]!;
const acmeDigest = companionDigest(acme.path);

/** The same services with `acme` selected and an empty collected payload. */
const selecting = (studio: StudioServices) =>
  ({
    ...studio,
    page: async (url: URL) => ({
      ...(await studio.page(url)),
      companion: acme,
      payload: {
        companionPath: acme.path,
        changes: [],
        specs: [],
        skills: [],
        topology: null,
        worksets: [],
        linkedRepositories: [],
        worksetProblems: [],
        warnings: [],
      },
    }),
  }) as unknown as StudioServices;

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
  test("serves lazy Usage in both plain-install modes without collecting on the server", async () => {
    let asked = 0;
    const studio = {
      ...selecting(services),
      factoryMode: false,
      usage: async () => {
        asked += 1;
        throw new Error("not during document rendering");
      },
    } as unknown as StudioServices;
    for (const studioMode of ["engineering", "analysis"]) {
      const { response } = await follow(
        `/usage?companion=${acmeDigest}&studioMode=${studioMode}`,
        studio,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/usage\?/);
      expect(html).toContain('role="status">Loading…');
      expect(html).not.toContain('href="/factory');
      expect(html).not.toContain("Consumed tokens");
    }
    expect(asked).toBe(0);
  });
  test("serves both guides from a relocated bundle without the docs checkout or network", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "acme-studio-offline-"));
    try {
      await cp(path.dirname(SERVER), folder, { recursive: true });
      const { default: handler } = await import(path.join(folder, "server.js"));
      for (const topic of ["worktrees", "vscode"]) {
        const response = await handler.fetch(
          new Request(
            `http://127.0.0.1/getting-started/${topic}?companion=${acmeDigest}&studioMode=engineering`,
          ),
          { context: { studio: selecting(services) } },
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(
          topic === "worktrees" ? "What is isolated" : "Install the extension",
        );
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  test("renders bundled developer guides with the initial response and native links", async () => {
    const selected = { ...selecting(services), factoryMode: false };
    for (const [topic, expected] of [
      ["", "Your first isolated change"],
      ["/worktrees", "What is isolated"],
      ["/vscode", "Install the extension"],
    ]) {
      const { response } = await follow(
        `/getting-started${topic}?companion=${acmeDigest}&studioMode=engineering`,
        selected,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      const main = html.slice(html.indexOf('id="studio-main"'), html.indexOf("</main>"));
      expect(main).toContain(expected!);
      expect(main).toContain("mate");
      expect(main).toContain('aria-current="page"');
      expect(
        main.slice(main.indexOf("<nav"), main.indexOf("</nav>")).match(/aria-current="page"/g),
      ).toHaveLength(1);
      expect(main).not.toContain("iframe");
      expect(main).not.toContain("md-frontmatter");
      expect(html).not.toContain('href="/factory');
      expect(main).toContain(`/getting-started/worktrees?companion=${acmeDigest}`);
    }
  });

  test("keeps the companion picker and Analysis fallback for guide routes", async () => {
    const { response } = await follow(
      "/getting-started/worktrees?studioMode=engineering",
      services,
    );
    expect(await response.text()).toContain("Choose a Companion Repository");
    const analysis = await follow(
      `/getting-started/vscode?companion=${acmeDigest}&studioMode=analysis`,
      selecting(services),
    );
    expect(analysis.location.pathname).toBe("/");
    expect(await analysis.response.text()).not.toContain('aria-label="Getting Started topics"');
  });

  test("keeps heading targets when canonicalizing a direct guide URL", async () => {
    const result = await follow(
      `/getting-started/worktrees?companion=${acmeDigest}#clean-up-safely`,
      selecting(services),
    );
    expect(result.location.searchParams.get("studioMode")).toBe("engineering");
    expect(result.location.hash).toBe("#clean-up-safely");
  });

  test("unknown guide slugs show a local way back, never arbitrary content", async () => {
    const { response } = await follow(
      `/getting-started/acme-unknown?companion=${acmeDigest}&studioMode=engineering`,
      selecting(services),
    );
    const html = await response.text();
    expect(html).toContain("Guide not found");
    expect(html).toContain("Return to Start here");
  });

  test("serves the document and its sidebar under Bun", async () => {
    const handler = await built();
    const response = await handler.fetch(
      new Request(`http://127.0.0.1/workflow?companion=${acmeDigest}&studioMode=engineering`),
      { context: { studio: selecting(services) } },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Mate Studio</title>");
    // The top bar and sidebar are server-rendered with the document.
    expect(html).toContain('id="studio-rail"');
    expect(html).toContain('class="studio-top');
  });

  test("shows the companion list alone, without the sidebar or the switcher", async () => {
    const handler = await built();
    const response = await handler.fetch(new Request("http://127.0.0.1/?studioMode=engineering"), {
      context: { studio: services },
    });
    const html = await response.text();
    expect(html).toContain("Choose a Companion Repository");
    expect(html).toContain("data-picker");
    expect(html).not.toContain('id="studio-rail"');
    expect(html).not.toContain('id="studio-companion"');
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

  test("draws a read-only view with the document, without its placeholder", async () => {
    const companion = page.inventory.companions[0]!;
    const withChange = {
      ...services,
      page: async (url: URL) => ({
        ...(await services.page(url)),
        companion,
        payload: {
          companionPath: companion.path,
          changes: [{ name: "acme-drawn-change", completedTasks: 1, totalTasks: 2, artifacts: [] }],
          specs: [],
          skills: [],
          topology: null,
          worksets: [],
          linkedRepositories: [],
          worksetProblems: [],
          warnings: [],
        },
      }),
    } as unknown as StudioServices;
    const digest = companionDigest(companion.path);
    const { response } = await follow(`/?companion=${digest}&studioMode=engineering`, withChange);
    const html = await response.text();
    const main = html.slice(html.indexOf('id="studio-main"'), html.indexOf("</main>"));
    expect(main).toContain("acme-drawn-change");
    expect(main).not.toContain("view-placeholder");
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
    const served = await handler.fetch(
      new Request(`http://127.0.0.1/?companion=${acmeDigest}&studioMode=analysis`),
      { context: { studio: selecting(appliance) } },
    );
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(html).toContain("Engineering is unavailable in the appliance.");
    expect(html).not.toMatch(/href="\/(workflow|skills|factory)/);
  });

  test("keeps the graph renderer in its own chunk", async () => {
    const assets = path.join(import.meta.dir, "../dist/client/assets");
    const chunks = (await readdir(assets)).filter((name) => name.endsWith(".js"));
    const carrying: string[] = [];
    for (const name of chunks) {
      // oxlint-disable-next-line no-await-in-loop -- a few dozen small files
      const source = await readFile(path.join(assets, name), "utf8");
      // A sigma shader and a graphology method stand for each library.
      if (source.includes("sdf_diamond") || source.includes("addUndirectedEdgeWithKey")) {
        carrying.push(name);
      }
    }
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toStartWith("graph-canvas-");
  });

  test("serves the Graph view without building the graph on the server", async () => {
    let asked = 0;
    const studio = {
      ...selecting(services),
      graph: async () => {
        asked += 1;
        throw new Error("not on the server");
      },
    } as unknown as StudioServices;
    for (const studioMode of ["engineering", "analysis"]) {
      const { response } = await follow(
        `/graph?companion=${acmeDigest}&studioMode=${studioMode}&node=spec%3Aacme-gone`,
        studio,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/graph\?/);
    }
    expect(asked).toBe(0);
  });
});
