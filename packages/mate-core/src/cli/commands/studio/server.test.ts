import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStudioAccess } from "./access";
import { companionDigest, openFile, openFolder, parse, parseVaultSelection } from "./selection";
import {
  createStudioFetch,
  serveUntilInterrupted,
  startStudioServer,
  STUDIO_IDLE_TIMEOUT_SECONDS,
  type StudioServerDeps,
} from "./server";
import { renderStudioDocument, renderVaultView } from "./views/document";
import type { StudioPage } from "./views/model";
import { createVaultManager, type VaultManager, type VaultTreeResult } from "./vault";

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

  test("serves the vault page before a pending listing and inlines a listed tree", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-defer-")));
    try {
      await fs.mkdir(path.join(root, "docs"));
      await fs.writeFile(path.join(root, "docs", "note.md"), "one");
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const vault = createVaultManager({
        watch: () => ({ close() {} }),
        git: async (args) => {
          await gate;
          return args.includes("ls-files")
            ? { code: 0, stdout: "docs/note.md\0", stderr: "" }
            : { code: 1, stdout: "", stderr: "" };
        },
      });
      const pages: StudioPage[] = [];
      const handler = createStudioFetch({
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        renderDocument: (page) => {
          pages.push(page);
          return "page";
        },
        vault,
      });
      const digest = companionDigest(root);
      const pageUrl = `http://localhost/?companion=${digest}&view=vault&path=docs%2Fnote.md`;

      expect((await handler(new Request(pageUrl)))!.status).toBe(200);
      expect(pages[0]?.vault?.tree).toBeNull();
      expect(pages[0]?.vault?.open?.content).toBe("one");

      const view = handler(
        new Request(`http://localhost/api/vault/view?companion=${digest}&dir=docs`),
      );
      release();
      const answered = (await view)!;
      expect(answered.headers.get("content-type")).toContain("text/html");
      const markup = await answered.text();
      expect(markup).toContain('data-vault-slot="tree"');
      expect(markup).toContain('data-vault-slot="listing"');
      expect(markup).toContain("note.md");
      expect(markup).toContain(
        `<a class="vault-file" href="/?companion=${digest}&amp;view=vault&amp;path=docs%2Fnote.md" data-vault-entry="docs/note.md"`,
      );

      await handler(new Request(pageUrl));
      expect(JSON.stringify(pages[1]?.vault?.tree)).toContain("note.md");
      vault.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.each(["listed", "failed"] as const)(
    "page and /view agree on vault state when listing is %s",
    async (result) => {
      const digest = companionDigest(ACME);
      const tree: VaultTreeResult = {
        tree: [{ name: "note.md", path: "note.md", kind: "file" }],
        watching: true,
        warning: null,
      };
      const listing = async (): Promise<VaultTreeResult> => {
        if (result === "failed") throw new Error("listing failed");
        return tree;
      };
      const opened: string[] = [];
      const vault = {
        prefetch: listing,
        tree: listing,
        open: async (_root: string, file: string) => {
          opened.push(file);
          return { path: file, content: "acme", token: "v1" };
        },
        deactivate: () => {},
        stop: () => {},
      } as VaultManager;
      const pages: StudioPage[] = [];
      const handler = createStudioFetch({
        collectStudioInventory: async () => ({
          companions: [{ path: ACME, health: "ready", pairings: [] }],
        }),
        renderDocument: (page) => {
          pages.push(page);
          return renderStudioDocument(page);
        },
        vault,
      });
      const query = `companion=${digest}&view=vault&path=note.md`;

      const page = (await handler(new Request(`http://localhost/?${query}`)))!;
      const view = (await handler(new Request(`http://localhost/api/vault/view?${query}`)))!;
      expect(page.status).toBe(200);
      expect(view.status).toBe(200);
      expect(pages[0]?.error).toBeNull();
      expect(pages[0]?.vault).toMatchObject({
        tree: result === "listed" ? tree.tree : null,
        failure: result === "failed" ? "listing failed" : null,
        open: { path: "note.md", content: "acme", token: "v1" },
      });
      expect(await view.text()).toBe(renderVaultView(pages[0]!));
      expect(opened).toEqual(["note.md", "note.md"]);
      const markup = await page.text();
      expect(markup).toContain("data-vault-layout");
      if (result === "failed") {
        expect(markup).toContain("The files could not be listed: listing failed");
        expect(markup).toContain("Refresh tree");
      }
      await handler.close();
    },
  );

  test("renders a full vault page with a listing failure in the tree", async () => {
    const vault = {
      prefetch: async () => {
        throw new Error("listing failed");
      },
      deactivate: () => {},
      stop: () => {},
    } as unknown as VaultManager;
    const pages: StudioPage[] = [];
    const handler = createStudioFetch({
      collectStudioInventory: async () => ({
        companions: [{ path: ACME, health: "ready", pairings: [] }],
      }),
      renderDocument: (page) => {
        pages.push(page);
        return renderStudioDocument(page);
      },
      vault,
    });

    const response = (await handler(
      new Request(`http://localhost/?companion=${companionDigest(ACME)}&view=vault`),
    ))!;
    const markup = await response.text();
    expect(response.status).toBe(200);
    expect(pages[0]?.error).toBeNull();
    expect(pages[0]?.vault?.failure).toBe("listing failed");
    expect(markup).toContain('data-vault-slot="tree"');
    expect(markup).toContain("The files could not be listed: listing failed");
    expect(markup).toContain("Refresh tree");
    await handler.close();
  });

  test("answers deferred forms that stay in the vault with their file and folder", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-defer-")));
    try {
      await fs.mkdir(path.join(root, "docs", "a"), { recursive: true });
      for (const file of ["README.md", "docs/b.md", "docs/a/x.md"]) {
        await fs.writeFile(path.join(root, file), "# acme\n");
      }
      const vault = createVaultManager({
        watch: () => ({ close() {} }),
        git: async (args) =>
          args.includes("ls-files")
            ? { code: 0, stdout: "README.md\0docs/b.md\0docs/a/x.md\0", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
      });
      const handler = createStudioFetch({
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        vault,
      });
      const digest = companionDigest(root);
      const markup = await (await handler(
        new Request(`http://localhost/api/vault/view?companion=${digest}&dir=docs%2Fa`),
      ))!.text();
      const submitted = [...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(
        ([, attrs, body]) => {
          const url = new URL("http://localhost/");
          for (const [, name, value] of body!.matchAll(
            /<input type="hidden" name="([^"]*)" value="([^"]*)"\/>/g,
          )) {
            url.searchParams.append(name!, value!);
          }
          return { entry: /data-vault-entry="([^"]*)"/.exec(attrs!)?.[1], selection: parse(url) };
        },
      );
      const links = [
        ...markup.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*data-vault-entry="([^"]*)"/g),
      ].map(([, href, entry]) => ({
        entry,
        selection: parse(new URL(href!.replaceAll("&amp;", "&"), "http://localhost/")),
      }));
      expect(links.length).toBeGreaterThan(2);
      submitted.push(...links);
      expect(submitted.length).toBeGreaterThan(4);
      for (const { entry, selection } of submitted) {
        expect(selection.view).toBe("vault");
        expect(selection.companionDigest).toBe(digest);
        if (entry) expect(selection).toMatchObject({ openPath: entry, openDir: null });
      }
      const targets = submitted.map(({ selection }) => selection);
      expect(targets).toContainEqual(
        openFile(
          parseVaultSelection(new URL(`http://localhost/?companion=${digest}`)),
          "docs/a/x.md",
        ),
      );
      expect(targets).toContainEqual(
        openFolder(parseVaultSelection(new URL(`http://localhost/?companion=${digest}`)), "docs"),
      );
      vault.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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

    test("answers a listed folder's entries, collapsed, with the listing generation", async () => {
      await lazyFixture(async ({ handler, digest }) => {
        const response = (await handler(
          new Request(`http://localhost/api/vault/dir?companion=${digest}&dir=docs`),
        ))!;
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("x-vault-generation")).toBe("0");
        const markup = await response.text();
        expect(markup).toContain('data-vault-entry="docs/b.md"');
        expect(markup).toContain('data-vault-dir="docs/a"');
        expect(markup).not.toContain("x.md");
      });
    });

    test("refuses a folder the listed tree does not hold, never reading the disk", async () => {
      await lazyFixture(async ({ handler, digest }) => {
        for (const dir of ["nope", "../outside", "/etc"]) {
          const response = (await handler(
            new Request(
              `http://localhost/api/vault/dir?companion=${digest}&dir=${encodeURIComponent(dir)}`,
            ),
          ))!;
          expect(response.status).toBe(404);
        }
        const none = (await handler(new Request("http://localhost/api/vault/dir")))!;
        expect(none.status).toBe(400);
      });
    });

    test("answers bounded name-filter matches over unexpanded folders", async () => {
      await lazyFixture(async ({ handler, digest }) => {
        const response = (await handler(
          new Request(`http://localhost/api/vault/filter?companion=${digest}&q=y.MD`),
        ))!;
        const markup = await response.text();
        expect(markup).toContain('data-vault-entry="other/Y.md"');
        expect(markup).not.toContain("README");
        const empty = (await handler(
          new Request(`http://localhost/api/vault/filter?companion=${digest}`),
        ))!;
        expect(await empty.text()).toBe("");
      });
    });

    test("streams listing generations, never paths or content", async () => {
      await lazyFixture(async ({ handler, digest }) => {
        const response = (await handler(
          new Request(`http://localhost/api/vault/changes?companion=${digest}`),
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
        expect(JSON.parse(data.slice(5))).toEqual({ generation: 0 });
        await reader.cancel();
        const unselected = (await handler(new Request("http://localhost/api/vault/changes")))!;
        expect(unselected.status).toBe(400);
      });
    });

    test("holds the new read routes to the access token", async () => {
      const access = createStudioAccess({
        invocation: "serve",
        terminal: false,
        hostname: "127.0.0.1",
        port: () => 80,
        token: "secret",
      });
      const handler = createStudioFetch({}, { access });
      for (const route of ["dir", "filter", "changes"]) {
        const response = (await handler(new Request(`http://127.0.0.1/api/vault/${route}`)))!;
        expect(response.status).toBe(401);
      }
      await handler.close();
    });
  });

  test("answers a failed listing in place of the tree", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-defer-")));
    try {
      const vault = createVaultManager({
        watch: () => ({ close() {} }),
        git: async () => ({ code: 128, stdout: "", stderr: "fatal: acme broke" }),
      });
      const handler = createStudioFetch({
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        vault,
      });
      const response = (await handler(
        new Request(`http://localhost/api/vault/view?companion=${companionDigest(root)}`),
      ))!;
      expect(response.status).toBe(200);
      const markup = await response.text();
      expect(markup).toContain('data-vault-slot="tree"');
      expect(markup).toContain("could not be listed: git ls-files failed: fatal: acme broke");
      vault.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("serves a vault tree and file, while read-only saves are refused", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-server-"));
    try {
      await fs.writeFile(path.join(root, "note.md"), "one");
      const digest = companionDigest(root);
      const manager = createVaultManager({ watch: () => ({ close() {} }) });
      const handler = createStudioFetch({
        collectStudioInventory: async () => ({
          companions: [{ path: root, health: "ready", pairings: [] }],
        }),
        assembleCompanionPayload: async (companionPath) => ({
          companionPath,
          changes: [],
          specs: [],
          topology: null,
          warnings: [],
        }),
        renderDocument: () => "vault",
        vault: manager,
      });
      const tree = await handler(
        new Request(`http://localhost/api/vault/tree?companion=${digest}`),
      );
      expect((await tree.json()).tree).toHaveLength(1);
      const opened = await handler(
        new Request(`http://localhost/api/vault/file?companion=${digest}&path=note.md`),
      );
      expect(await opened.json()).toMatchObject({ path: "note.md", content: "one" });
      const refused = await handler(
        new Request("http://localhost/api/vault/save", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: "{}",
        }),
      );
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("--writable");
      handler.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("writes only through the writable vault save endpoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-server-"));
    try {
      await fs.writeFile(path.join(root, "note.md"), "one");
      const digest = companionDigest(root);
      const handler = createStudioFetch(
        {
          collectStudioInventory: async () => ({
            companions: [{ path: root, health: "ready", pairings: [] }],
          }),
          assembleCompanionPayload: async (companionPath) => ({
            companionPath,
            changes: [],
            specs: [],
            topology: null,
            warnings: [],
          }),
          renderDocument: () => "vault",
          vault: createVaultManager({ watch: () => ({ close() {} }) }),
        },
        { writable: true },
      );
      const opened = await (
        await handler(
          new Request(`http://localhost/api/vault/file?companion=${digest}&path=note.md`),
        )
      ).json();
      const saved = await handler(
        new Request("http://localhost/api/vault/save", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost" },
          body: JSON.stringify({
            companion: digest,
            path: "note.md",
            content: "two",
            token: opened.token,
          }),
        }),
      );
      expect(saved.status).toBe(200);
      expect(await fs.readFile(path.join(root, "note.md"), "utf8")).toBe("two");
      handler.close();
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
