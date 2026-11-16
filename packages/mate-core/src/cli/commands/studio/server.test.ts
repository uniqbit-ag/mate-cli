/** @test-requires sockets */

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStudioAccess } from "./access";
import { companionDigest, parse } from "./selection";
import {
  createStudioFetch,
  serveUntilInterrupted,
  startStudioServer,
  STUDIO_IDLE_TIMEOUT_SECONDS,
  type StudioServerDeps,
} from "./server";
import type { StudioPage } from "./views/model";
import { createReportStore } from "./reports";
import { createVaultManager, type VaultManager } from "./vault";

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
    ...overrides,
  };
}

/** Captures the state each address is collected into, so the URL is what is asserted. */
function capturing(overrides: Partial<StudioServerDeps> = {}) {
  const pages: StudioPage[] = [];
  const assembled: string[] = [];
  const fetch = createStudioFetch(
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
      ...overrides,
    }),
  );
  const open = async (address: string) => {
    pages.push(await fetch.services.page(new URL(address)));
  };
  return { fetch, open, pages, assembled };
}

describe("createStudioFetch", () => {
  test("serves the document at the root", async () => {
    const response = await createStudioFetch(deps())(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("<!doctype html>");
  });

  test("serves no other name under the client's route", async () => {
    const handler = createStudioFetch(deps());
    for (const pathname of [
      "/studio/client.js/",
      "/studio/client.js.map",
      "/studio/client/main.ts",
      "/studio/../package.json",
      "/studio/client.ts",
    ]) {
      const response = await handler(new Request(`http://localhost${pathname}`));
      expect(response.headers.get("content-type") ?? "").not.toContain("javascript");
    }
  });

  test("collects the state the URL names", async () => {
    const { open, pages, assembled } = capturing();
    const digest = companionDigest(ACME);

    await open(`http://localhost/?companion=${digest}&change=add-auth&view=workflow`);
    expect(assembled).toEqual([ACME]);
    expect(pages[0]?.selection).toEqual({
      companionDigest: digest,
      studioMode: "engineering",
      view: "workflow",
      refresh: false,
    });
    expect(pages[0]?.companion?.path).toBe(ACME);
    expect(pages[0]?.payload?.companionPath).toBe(ACME);
  });

  test("resolves every page through the startup profile, never the request", async () => {
    const standard = capturing();
    await standard.open("http://localhost/?studioMode=analysis&view=specs");
    await standard.open("http://localhost/?role=business-analyst");
    await standard.open("http://localhost/");
    expect(standard.fetch.services.modePolicy.enabled).toEqual(["engineering", "analysis"]);
    expect(standard.pages.map((page) => page.selection.studioMode)).toEqual([
      "analysis",
      "analysis",
      "engineering",
    ]);

    const fetch = createStudioFetch(deps(), { profile: "appliance" });
    expect(fetch.services.modePolicy).toMatchObject({
      profile: "appliance",
      enabled: ["analysis"],
    });
    for (const address of [
      "http://localhost/",
      "http://localhost/?studioMode=engineering&view=workflow",
      "http://localhost/?role=product-engineer&view=factory",
      "http://localhost/?studioMode=bogus&profile=standard",
    ]) {
      const page = await fetch.services.page(new URL(address));
      expect(page.selection).toMatchObject({ studioMode: "analysis", view: "dashboard" });
    }
    await fetch.close();
    await standard.fetch.close();
  });

  test("assembles nothing when no companion is named", async () => {
    const { open, pages, assembled } = capturing();

    await open("http://localhost/");
    expect(assembled).toEqual([]);
    expect(pages[0]?.companion).toBeNull();
    expect(pages[0]?.payload).toBeNull();
    expect(pages[0]?.inventory.companions).toHaveLength(2);
  });

  test("falls back to the selector for an unresolvable companion", async () => {
    const { open, pages, assembled } = capturing();

    await open("http://localhost/?companion=deadbeef00");
    expect(assembled).toEqual([]);
    expect(pages[0]?.companion).toBeNull();
    expect(pages[0]?.error).toBeNull();
  });

  test("collects an error payload rather than failing", async () => {
    const { open, pages } = capturing({
      assembleCompanionPayload: async (companionPath) => ({
        error: { companionPath, reason: "openspec list --json: exit code 1" },
      }),
    });

    await open(`http://localhost/?companion=${companionDigest(ACME)}`);
    expect(pages[0]?.error).toEqual({
      companionPath: ACME,
      reason: "openspec list --json: exit code 1",
    });
    expect(pages[0]?.payload).toBeNull();
  });

  test("keeps serving after one companion throws, and every other stays reachable", async () => {
    const { open, pages } = capturing();

    await open(`http://localhost/?companion=${companionDigest(BROKEN)}`);
    expect(pages[0]?.error).toEqual({ companionPath: BROKEN, reason: "unreadable" });
    expect(pages[0]?.inventory.companions).toHaveLength(2);

    await open(`http://localhost/?companion=${companionDigest(ACME)}`);
    expect(pages[1]?.payload?.companionPath).toBe(ACME);
  });

  test("switching a view serves the collected snapshot rather than collecting again", async () => {
    const { open, pages, assembled } = capturing();
    const digest = companionDigest(ACME);

    await open(`http://localhost/?companion=${digest}`);
    await open(`http://localhost/?companion=${digest}&view=workflow`);
    await open(`http://localhost/?companion=${digest}&view=dashboard`);

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
    const { open, assembled } = capturing();
    const digest = companionDigest(ACME);

    await open(`http://localhost/?companion=${digest}`);
    await open(`http://localhost/?companion=${digest}&refresh=1`);

    expect(assembled).toEqual([ACME, ACME]);
  });

  test("each companion holds its own snapshot", async () => {
    const collected: string[] = [];
    const { services } = createStudioFetch(
      deps({
        assembleCompanionPayload: async (companionPath) => {
          collected.push(companionPath);
          return { companionPath, changes: [], specs: [], topology: null, warnings: [] };
        },
      }),
    );
    const open = (address: string) => services.page(new URL(address));

    await open(`http://localhost/?companion=${companionDigest(ACME)}`);
    await open(`http://localhost/?companion=${companionDigest(BROKEN)}`);
    await open(`http://localhost/?companion=${companionDigest(ACME)}`);

    expect(collected).toEqual([ACME, BROKEN]);
  });

  test("a companion whose collection threw is collected again on the next request", async () => {
    const { open, assembled } = capturing();
    const digest = companionDigest(BROKEN);

    await open(`http://localhost/?companion=${digest}`);
    await open(`http://localhost/?companion=${digest}`);

    expect(assembled).toEqual([BROKEN, BROKEN]);
  });

  test("says the application build is missing when a checkout was never built", async () => {
    const handler = createStudioFetch({
      collectStudioInventory: async () => ({
        companions: [{ path: ACME, health: "ready", pairings: [] }],
      }),
    });

    const body = await (
      await handler(new Request(`http://localhost/?companion=${companionDigest(ACME)}`))
    ).text();

    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Studio's application build is missing.");
  });

  test.each(["/api/inventory", "/api/companion", "/api/companion?path=/companions/acme"])(
    "answers %s as unrouted rather than serving its old payload",
    async (route) => {
      const { fetch, assembled } = capturing();

      const response = await fetch(new Request(`http://localhost${route}`));

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

  describe("lazy vault routes", () => {
    async function lazyFixture(
      run: (context: {
        handler: ReturnType<typeof createStudioFetch>;
        digest: string;
        vault: VaultManager;
      }) => Promise<void>,
    ) {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-lazy-")));
      try {
        const vault = createVaultManager({
          watch: () => ({ close() {} }),
          git: async (args) =>
            args.includes("ls-files")
              ? { code: 0, stdout: "README.md\0docs/b.md\0docs/a/x.md\0other/Y.md\0", stderr: "" }
              : { code: 1, stdout: "", stderr: "" },
        });
        const files = ["README.md", "docs/b.md", "docs/a/x.md", "other/Y.md"];
        for (const file of files) {
          await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await fs.writeFile(path.join(root, file), "# acme\n");
        }
        const handler = createStudioFetch({
          collectStudioInventory: async () => ({
            companions: [{ path: root, health: "ready", pairings: [] }],
          }),
          vault,
        });
        await run({ handler, digest: companionDigest(root), vault });
        await handler.close();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }

    test("streams listing generations, never paths or content", async () => {
      await lazyFixture(async ({ handler, digest }) => {
        const response = (await handler(
          new Request(`http://localhost/api/events?companion=${digest}`),
        ))!;
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const reader = response.body!.getReader();
        const chunks: string[] = [];
        while (!chunks.join("").includes("data:")) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
        const data = chunks
          .join("")
          .split("\n")
          .find((line) => line.startsWith("data:"))!;
        expect(JSON.parse(data.slice(5))).toEqual({ type: "vault-tree", generation: 0 });
        await reader.cancel();
        const unselected = (await handler(new Request("http://localhost/api/events")))!;
        expect(unselected.status).toBe(400);
      });
    });

    test("a view's page read keeps the events stream's tree updates", async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-keep-")));
      try {
        await fs.writeFile(path.join(root, "README.md"), "# acme\n");
        const listeners = new Map<string, (event: string, filename: string | null) => void>();
        const handler = createStudioFetch({
          collectStudioInventory: async () => ({
            companions: [{ path: root, health: "ready", pairings: [] }],
          }),
          vault: createVaultManager({
            watch: (directory, listener) => {
              listeners.set(
                directory,
                listener as (event: string, filename: string | null) => void,
              );
              return { close: () => listeners.delete(directory) };
            },
          }),
        });
        const digest = companionDigest(root);
        const response = (await handler(
          new Request(`http://localhost/api/events?companion=${digest}`),
        ))!;
        const reader = response.body!.getReader();
        const generations: number[] = [];
        const next = async () => {
          const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000));
          const chunk = await Promise.race([reader.read(), timeout]);
          if (!chunk || chunk.done) return null;
          for (const line of new TextDecoder().decode(chunk.value).split("\n")) {
            if (line.startsWith("data:")) generations.push(JSON.parse(line.slice(5)).generation);
          }
          return generations.at(-1) ?? null;
        };
        while ((await next()) === null && generations.length === 0);
        await new Promise((resolve) => setTimeout(resolve, 50));

        await handler.services.page(new URL(`http://studio.local/?companion=${digest}&view=specs`));
        await fs.writeFile(path.join(root, "added.md"), "# added\n");
        listeners.get(root)?.("rename", "added.md");
        expect(await next()).toBeGreaterThan(0);
        await reader.cancel();
        await handler.close();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    test("holds the vault's read routes to the access token", async () => {
      const access = createStudioAccess({
        invocation: "serve",
        terminal: false,
        hostname: "127.0.0.1",
        port: () => 80,
        token: "secret",
      });
      const handler = createStudioFetch({}, { access });
      for (const route of ["/api/vault/events?path=a.md", "/api/events", "/vault"]) {
        const response = (await handler(new Request(`http://127.0.0.1${route}`)))!;
        expect(response.status).toBe(401);
      }
      await handler.close();
    });
  });

  test("serves the vault through the services, while read-only saves are refused", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-server-"));
    try {
      await fs.writeFile(path.join(root, "note.md"), "one");
      const digest = companionDigest(root);
      const handler = createStudioFetch({
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        vault: createVaultManager({ watch: () => ({ close() {} }) }),
      });
      const view = await handler.services.vault(digest, { path: "note.md", wait: true });
      expect(view.tree).toHaveLength(1);
      expect(view.open).toMatchObject({ path: "note.md", content: "one" });
      await expect(
        handler.services.vaultSave(digest, "note.md", "two", view.open!.token),
      ).rejects.toThrow("--writable");
      expect(await fs.readFile(path.join(root, "note.md"), "utf8")).toBe("one");
      await handler.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a writable vault saves the current version and refuses a stale one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-server-"));
    try {
      await fs.writeFile(path.join(root, "note.md"), "one");
      const digest = companionDigest(root);
      const handler = createStudioFetch(
        {
          collectStudioInventory: async () => ({
            companions: [{ path: root, health: "ready", pairings: [] }],
          }),
          vault: createVaultManager({ watch: () => ({ close() {} }) }),
        },
        { writable: true },
      );
      const { open } = await handler.services.vault(digest, { path: "note.md", wait: true });
      const saved = await handler.services.vaultSave(digest, "note.md", "two", open!.token);
      expect(saved.kind).not.toBe("conflict");
      expect(await fs.readFile(path.join(root, "note.md"), "utf8")).toBe("two");
      const stale = await handler.services.vaultSave(digest, "note.md", "three", open!.token);
      expect(stale.kind).toBe("conflict");
      expect(await fs.readFile(path.join(root, "note.md"), "utf8")).toBe("two");
      await expect(handler.services.vaultSave(digest, "../escape.md", "x")).rejects.toThrow();
      await expect(handler.services.vaultSave("0".repeat(16), "note.md", "x")).rejects.toThrow(
        "no registered companion",
      );
      await handler.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("lists a registered companion's reports and refuses an unregistered one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-reports-"));
    try {
      const store = createReportStore({ root });
      const handler = createStudioFetch(deps({ reports: store }));
      const digest = companionDigest(ACME);
      expect(await handler.services.reports(digest)).toEqual([]);
      await store.publish(digest, { title: "Acme release", html: "<p>acme</p>" });
      const listed = await handler.services.reports(digest);
      expect(listed.map((report) => report.title)).toEqual(["Acme release"]);
      await expect(handler.services.reports("0".repeat(16))).rejects.toThrow(
        "no registered companion",
      );
      await handler.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("forbids framing on every response but a hosted report's", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-frame-"));
    try {
      const store = createReportStore({ root });
      const { id } = await store.publish(companionDigest(ACME), {
        title: "Acme release",
        html: "<p>acme</p>",
      });
      const handler = createStudioFetch(deps({ reports: store }), {
        app: {
          clientDir: root,
          fetch: async () =>
            new Response("<p>page</p>", {
              headers: { "content-security-policy": "default-src 'self'" },
            }),
        },
      });

      const page = (await handler(new Request("http://localhost/")))!;
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("content-security-policy")).toBe(
        "default-src 'self'; frame-ancestors 'none'",
      );

      const report = (await handler(new Request(`http://localhost/studio/reports/${id}`)))!;
      expect(report.status).toBe(200);
      expect(report.headers.get("x-frame-options")).toBeNull();
      expect(report.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts");
      expect(report.headers.get("content-security-policy")).not.toContain("frame-ancestors");
      await handler.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to delete the companion Studio was started for, through a symlink too", async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-pin-")));
    try {
      const root = path.join(base, "acme");
      await fs.mkdir(root);
      await fs.symlink(root, path.join(base, "acme-link"));
      const handler = createStudioFetch(
        {
          collectStudioInventory: async () => ({
            companions: [{ path: root, health: "ready", pairings: [] }],
          }),
          vault: createVaultManager({ watch: () => ({ close() {} }) }),
        },
        { writable: true, launchCompanion: path.join(base, "acme-link") },
      );
      await expect(handler.services.deleteCompanion(companionDigest(root))).rejects.toThrow(
        "Studio was started for this companion",
      );
      expect((await fs.stat(root)).isDirectory()).toBe(true);
      await handler.close();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  test("previews unsaved text as the file would render, without touching it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-server-"));
    try {
      await fs.writeFile(path.join(root, "note.md"), "one");
      const digest = companionDigest(root);
      const handler = createStudioFetch(
        {
          collectStudioInventory: async () => ({
            companions: [{ path: root, health: "ready", pairings: [] }],
          }),
          vault: createVaultManager({ watch: () => ({ close() {} }) }),
        },
        { writable: true },
      );
      const preview = await handler.services.vaultPreview(digest, "note.md", "## Launch plan");
      expect(preview).toEqual([{ t: "h2", c: ["Launch plan"] }]);
      expect(await fs.readFile(path.join(root, "note.md"), "utf8")).toBe("one");
      await expect(handler.services.vaultPreview("0".repeat(16), "note.md", "x")).rejects.toThrow(
        "no registered companion",
      );
      await handler.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("pushes changed and removed open files through the event stream", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-server-"));
    try {
      await fs.writeFile(path.join(root, "note.md"), "one");
      let listener: ((event: string, filename: string | Buffer | null) => void) | undefined;
      const manager = createVaultManager({
        watch: (_root, next) => {
          listener = next;
          return { close() {} };
        },
      });
      const digest = companionDigest(root);
      const handler = createStudioFetch({
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        vault: manager,
      });
      const response = await handler(
        new Request(`http://localhost/api/vault/events?companion=${digest}&path=note.md`),
      );
      const reader = response.body!.getReader();
      await reader.read();
      await fs.writeFile(path.join(root, "note.md"), "two");
      listener?.("change", "note.md");
      const changed = await reader.read();
      expect(new TextDecoder().decode(changed.value)).toContain('"content":"two"');
      await fs.unlink(path.join(root, "note.md"));
      listener?.("rename", "note.md");
      const removed = await reader.read();
      expect(new TextDecoder().decode(removed.value)).toContain('"kind":"removed"');
      await reader.cancel();
      handler.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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

  test("binds an explicit port and host and reports a named host", () => {
    const calls: Array<{ port: number; hostname: string }> = [];
    const server = startStudioServer(
      deps({
        serve: (options) => {
          calls.push({ port: options.port, hostname: options.hostname });
          return { port: options.port, stop: () => {} };
        },
      }),
      { port: 4180, hostname: "0.0.0.0" },
    );

    expect(calls).toEqual([{ port: 4180, hostname: "0.0.0.0" }]);
    expect(server.port).toBe(4180);
    expect(server.hostname).toBe("0.0.0.0");
    expect(server.url).toBe("http://0.0.0.0:4180");
  });

  test("passes an explicit idle timeout instead of the runtime default", () => {
    const timeouts: number[] = [];
    startStudioServer(
      deps({
        serve: (options) => {
          timeouts.push(options.idleTimeout);
          return { port: 4180, stop: () => {} };
        },
      }),
    );

    expect(timeouts).toEqual([STUDIO_IDLE_TIMEOUT_SECONDS]);
  });

  test("keeps an idle vault event stream open past the idle timeout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-idle-"));
    await fs.writeFile(path.join(root, "note.md"), "one");
    const server = startStudioServer(
      {
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        vault: createVaultManager({ watch: () => ({ close() {} }) }),
      },
      { idleTimeout: 1 },
    );
    try {
      const response = await fetch(
        `${server.url}/api/vault/events?companion=${companionDigest(root)}&path=note.md`,
      );
      const reader = response.body!.getReader();
      await reader.read();
      const outcome = await Promise.race([
        reader.read().then(
          () => "closed",
          () => "closed",
        ),
        new Promise((resolve) => setTimeout(() => resolve("open"), 4_500)),
      ]);
      expect(outcome).toBe("open");
      await reader.cancel();
    } finally {
      await server.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("formats IPv6 hosts as valid URLs", () => {
    const server = startStudioServer(
      deps({ serve: (options) => ({ port: options.port, stop: () => {} }) }),
      { port: 4180, hostname: "2001:db8::1" },
    );

    expect(server.url).toBe("http://[2001:db8::1]:4180");
  });

  test("renders the same document for interactive and serve bindings", async () => {
    const fetches: Array<(request: Request) => Promise<Response>> = [];
    const serve = (options: Parameters<NonNullable<StudioServerDeps["serve"]>>[0]) => {
      fetches.push(options.fetch);
      return { port: options.port || 4180, stop: () => {} };
    };
    const sharedDeps: StudioServerDeps = {
      collectStudioInventory: async () => ({ companions: [] }),
      assembleCompanionPayload: async (companionPath) => ({
        companionPath,
        changes: [],
        specs: [],
        topology: null,
        warnings: [],
      }),
      serve,
    };
    startStudioServer(sharedDeps, {});
    startStudioServer(sharedDeps, { port: 4180, hostname: "0.0.0.0" });

    const request = new Request("http://localhost/?view=workflow");
    expect(await (await fetches[0]!(request)).text()).toBe(
      await (await fetches[1]!(request)).text(),
    );
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

  test("stops the server on termination as well as interrupt", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const initialExitCode = process.exitCode;
      let stopped = false;
      const listeners: Record<string, () => void> = {};
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
          onSignal: (name, handler) => {
            listeners[name] = handler;
            return () => delete listeners[name];
          },
        },
      );

      listeners[signal]?.();
      await pending;
      expect(stopped).toBe(true);
      expect(Object.keys(listeners)).toEqual([]);
      expect(process.exitCode).toBe(initialExitCode);
    }
  });
});
