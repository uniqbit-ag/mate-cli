import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createStudioAccess,
  normalizeAuthority,
  normalizeOrigin,
  studioAddress,
  tokensEqual,
  type StudioAccessOptions,
} from "./access";
import { companionDigest } from "./selection";
import { createStudioFetch, type StudioFetchOptions, type StudioServerDeps } from "./server";
import type { StudioApp } from "./studio-app";
import { createVaultManager, type VaultManager } from "./vault";

const PORT = 4097;
const TOKEN = "t".repeat(43);
const COOKIE = `mate_studio_${PORT}=${TOKEN}`;

function access(overrides: Partial<StudioAccessOptions> = {}) {
  return createStudioAccess({
    invocation: "interactive",
    terminal: false,
    hostname: "127.0.0.1",
    port: () => PORT,
    ...overrides,
  });
}

interface Fixture {
  root: string;
  digest: string;
  rendered: number;
  vault: VaultManager;
  deps: StudioServerDeps;
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-access-"));
  await fs.writeFile(path.join(root, "note.md"), "one");
  const vault = createVaultManager({ watch: () => ({ close() {} }) });
  const state: Fixture = { root, digest: companionDigest(root), rendered: 0, vault, deps: {} };
  state.deps = {
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
    vault,
    launchableAgents: async () => [],
  };
  return state;
}

/**
 * Studio's application as the server sees it: a document names the selected companion,
 * and the `save` server function saves through the services, as the real one does.
 */
function appFor(state: Fixture): StudioApp {
  return {
    clientDir: state.root,
    fetch: async (request, { context }) => {
      const url = new URL(request.url);
      if (url.pathname === "/_serverFn/save") {
        const { token } = (await request.json()) as { token: string };
        const saved = await context.studio
          .vaultSave(state.digest, "note.md", "two", token)
          .catch((error: Error) => ({ refused: error.message }));
        return Response.json(saved, { status: "refused" in saved ? 403 : 200 });
      }
      state.rendered += 1;
      const page = await context.studio.page(url);
      return new Response(`<!doctype html><p>${page.companion?.path ?? ""}</p>`);
    },
  };
}

async function withFixture(run: (state: Fixture) => Promise<void>): Promise<void> {
  const state = await fixture();
  try {
    await run(state);
  } finally {
    await fs.rm(state.root, { recursive: true, force: true });
  }
}

function serve(state: Fixture, options: Omit<StudioFetchOptions, "app">) {
  return createStudioFetch(state.deps, { ...options, app: appFor(state) });
}

function get(pathname: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:${PORT}${pathname}`, {
    headers: { host: `localhost:${PORT}`, ...headers },
  });
}

/** A save through the application's server function: a write. */
async function save(
  handler: ReturnType<typeof createStudioFetch>,
  state: Fixture,
  headers: Record<string, string>,
): Promise<Response> {
  const { token } = await state.vault.open(state.root, "note.md");
  return (await handler(
    new Request(`http://localhost:${PORT}/_serverFn/save`, {
      method: "POST",
      headers: { host: `localhost:${PORT}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ token }),
    }),
  ))!;
}

describe("authority and origin parsing", () => {
  test("normalizes authorities exactly, dropping only the HTTP default port", () => {
    expect(normalizeAuthority("Studio.Acme.Test")).toBe("studio.acme.test");
    expect(normalizeAuthority("studio.acme.test:80")).toBe("studio.acme.test");
    expect(normalizeAuthority("studio.acme.test:8443")).toBe("studio.acme.test:8443");
    expect(normalizeAuthority("acme.test/path")).toBeNull();
    expect(normalizeAuthority("user@acme.test")).toBeNull();
    expect(normalizeAuthority("")).toBeNull();
  });

  test("accepts only an exact http(s) origin", () => {
    expect(normalizeOrigin("https://studio.acme.test")).toBe("https://studio.acme.test");
    expect(normalizeOrigin("https://studio.acme.test:443")).toBe("https://studio.acme.test");
    expect(normalizeOrigin("https://studio.acme.test/")).toBeNull();
    expect(normalizeOrigin("https://studio.acme.test/app")).toBeNull();
    expect(normalizeOrigin("ftp://studio.acme.test")).toBeNull();
    expect(normalizeOrigin("studio.acme.test")).toBeNull();
  });

  test("compares tokens of any length", () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual("short", TOKEN)).toBe(false);
    expect(tokensEqual(`${TOKEN}x`, TOKEN)).toBe(false);
  });
});

describe("accepted hosts", () => {
  test("answers to loopback names and the bound address on the bound port", () => {
    const policy = access({ hostname: "0.0.0.0" });
    for (const host of [
      `localhost:${PORT}`,
      `127.0.0.1:${PORT}`,
      `[::1]:${PORT}`,
      `0.0.0.0:${PORT}`,
    ]) {
      expect(policy.acceptedOrigin(get("/", { host }))).toBe(`http://${host}`);
    }
    expect(policy.acceptedOrigin(get("/", { host: "localhost:1234" }))).toBeNull();
    expect(policy.acceptedOrigin(get("/", { host: "localhost" }))).toBeNull();
  });

  test("answers to a configured host exactly, never a suffix or another port", () => {
    const policy = access({ allowedHosts: ["studio.acme.test"] });
    expect(policy.acceptedOrigin(get("/", { host: "studio.acme.test" }))).toBe(
      "http://studio.acme.test",
    );
    expect(policy.acceptedOrigin(get("/", { host: "evil.studio.acme.test" }))).toBeNull();
    expect(policy.acceptedOrigin(get("/", { host: "studio.acme.test:8080" }))).toBeNull();
    expect(policy.acceptedOrigin(get("/", { host: "studio.acme.test.evil" }))).toBeNull();
  });

  test("a rebinding hostname can neither read, exchange, nor save", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        writable: true,
        access: access({ invocation: "serve", token: TOKEN }),
      });
      const host = { host: `rebind.acme.test:${PORT}`, cookie: COOKIE };
      for (const pathname of [
        "/",
        `/factory?companion=${state.digest}`,
        `/api/events?companion=${state.digest}`,
        `/?token=${TOKEN}`,
      ]) {
        const response = (await handler(get(pathname, host)))!;
        expect(response.status).toBe(421);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await response.text()).not.toContain(state.root);
      }
      const saved = await save(handler, state, {
        ...host,
        origin: `http://rebind.acme.test:${PORT}`,
      });
      expect(saved.status).toBe(421);
      expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("one");
      await handler.close();
    });
  });
});

describe("save origins", () => {
  test.each([
    { name: "a foreign site", origin: "https://evil.test" },
    { name: "a same-site sibling", origin: `http://127.0.0.1:${PORT + 1}` },
    { name: "a missing origin", origin: undefined },
    { name: "a null origin", origin: "null" },
  ])("$name cannot save to the interactive command", async ({ origin }) => {
    await withFixture(async (state) => {
      const handler = serve(state, { writable: true, access: access() });
      const response = await save(handler, state, origin ? { origin } : {});
      expect(response.status).toBe(403);
      expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("one");
      await handler.close();
    });
  });

  test("a same-origin save needs the token cookie on the interactive command", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, { writable: true, access: access({ token: TOKEN }) });
      const origin = `http://localhost:${PORT}`;
      expect((await save(handler, state, { origin })).status).toBe(401);
      expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("one");
      expect((await save(handler, state, { origin, cookie: COOKIE })).status).toBe(200);
      expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("two");
      await handler.close();
    });
  });

  test("a same-site sibling holding the cookie cannot save to a guarded Studio", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        writable: true,
        access: access({ invocation: "serve", token: TOKEN, allowedHosts: ["studio.acme.test"] }),
      });
      const response = await save(handler, state, {
        host: "studio.acme.test",
        cookie: COOKIE,
        origin: "http://other.acme.test",
      });
      expect(response.status).toBe(403);
      expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("one");
      await handler.close();
    });
  });
});

describe("token issuance", () => {
  test("every Studio start issues a token, fresh per start", () => {
    const first = access().token;
    const second = access().token;
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(access({ invocation: "serve" }).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(access({ invocation: "serve", token: TOKEN }).token).toBe(TOKEN);
  });

  test("prints a loopback address, carrying only a generated token", () => {
    expect(studioAddress("0.0.0.0", PORT, "abc")).toBe(`http://localhost:${PORT}/?token=abc`);
    expect(studioAddress("127.0.0.1", PORT, null)).toBe(`http://localhost:${PORT}`);
    expect(studioAddress("10.0.0.5", PORT, "abc")).toBe(`http://10.0.0.5:${PORT}/?token=abc`);
    expect(studioAddress("fd00::5", PORT, null)).toBe(`http://[fd00::5]:${PORT}`);
  });
});

describe("token exchange", () => {
  test("a pasted token URL sets a host-only strict cookie and redirects without the token", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        access: access({ invocation: "serve", token: TOKEN }),
      });
      const response = (await handler(
        get(`/?view=vault&token=${TOKEN}&companion=${state.digest}`),
      ))!;
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/?view=vault&companion=${state.digest}`);
      expect(response.headers.get("set-cookie")).toBe(
        `${COOKIE}; Path=/; HttpOnly; SameSite=Strict`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(state.rendered).toBe(0);
      await handler.close();
    });
  });

  test("an invalid token is refused without touching the cookie", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        access: access({ invocation: "serve", token: TOKEN }),
      });
      const response = (await handler(get(`/?token=${"x".repeat(43)}`, { cookie: COOKIE })))!;
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      await handler.close();
    });
  });

  test("an HTTPS public origin on its own Host gets a Secure cookie; forwarded headers change nothing", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        access: access({
          invocation: "serve",
          token: TOKEN,
          publicOrigin: "https://studio.acme.test",
        }),
      });
      const proxied = (await handler(get(`/?token=${TOKEN}`, { host: "studio.acme.test" })))!;
      expect(proxied.headers.get("set-cookie")).toContain("; Secure");

      const direct = (await handler(
        get(`/?token=${TOKEN}`, { "x-forwarded-proto": "https", forwarded: "proto=https" }),
      ))!;
      expect(direct.status).toBe(303);
      expect(direct.headers.get("set-cookie")).not.toContain("Secure");
      await handler.close();
    });
  });

  test("a direct Host does not borrow the public origin for Origin matching", () => {
    const policy = access({ invocation: "serve", publicOrigin: "https://studio.acme.test" });
    const direct = get("/", { origin: "https://studio.acme.test" });
    const origin = policy.acceptedOrigin(direct)!;
    expect(origin).toBe(`http://localhost:${PORT}`);
    expect(policy.originMatches(direct, origin)).toBe(false);

    const proxied = get("/", { host: "studio.acme.test", origin: "https://studio.acme.test" });
    const publicOrigin = policy.acceptedOrigin(proxied)!;
    expect(publicOrigin).toBe("https://studio.acme.test");
    expect(policy.originMatches(proxied, publicOrigin)).toBe(true);
    expect(
      policy.originMatches(
        get("/", { host: "studio.acme.test", origin: "http://studio.acme.test" }),
        publicOrigin,
      ),
    ).toBe(false);
  });
});

describe("per-invocation token requirements", () => {
  test("serve refuses tokenless reads and explains how to get in", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        access: access({ invocation: "serve", token: TOKEN }),
      });
      const page = (await handler(get(`/?companion=${state.digest}`)))!;
      expect(page.status).toBe(401);
      const body = await page.text();
      expect(body).toContain("?token=");
      expect(body).not.toContain(state.root);
      expect(state.rendered).toBe(0);

      for (const pathname of [
        `/vault?companion=${state.digest}`,
        `/_serverFn/getFactory?companion=${state.digest}`,
        `/api/events?companion=${state.digest}`,
        `/api/vault/events?companion=${state.digest}&path=note.md`,
        `/api/reports?companion=${state.digest}`,
      ]) {
        const refused = (await handler(get(pathname)))!;
        expect(refused.status).toBe(401);
        expect(await refused.text()).not.toContain(state.root);
      }

      const served = (await handler(get(`/?companion=${state.digest}`, { cookie: COOKIE })))!;
      expect(served.status).toBe(200);
      expect(await served.text()).toContain(state.root);
      await handler.close();
    });
  });

  test("serve requires the token for a save, even same-origin", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        writable: true,
        access: access({ invocation: "serve", token: TOKEN }),
      });
      const origin = `http://localhost:${PORT}`;
      expect((await save(handler, state, { origin })).status).toBe(401);
      expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("one");
      expect((await save(handler, state, { origin, cookie: COOKIE })).status).toBe(200);
      await handler.close();
    });
  });

  test("the interactive terminal keeps reads open but guards saves and sessions", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        writable: true,
        terminal: true,
        access: access({ terminal: true, token: TOKEN }),
      });
      const page = (await handler(get(`/vault?companion=${state.digest}`)))!;
      expect(page.status).toBe(200);
      const origin = `http://localhost:${PORT}`;
      expect((await save(handler, state, { origin })).status).toBe(401);
      expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("one");
      expect((await handler(get("/api/terminal/sessions")))!.status).toBe(401);
      expect((await handler(get("/api/terminal/sessions", { cookie: COOKIE })))!.status).toBe(200);
      expect((await save(handler, state, { origin, cookie: COOKIE })).status).toBe(200);
      await handler.close();
    });
  });
});

describe("Studio modes are not access control", () => {
  test("no mode or profile changes the token, origin, or write checks", async () => {
    await withFixture(async (state) => {
      for (const profile of ["standard", "appliance"] as const) {
        const handler = serve(state, {
          writable: true,
          profile,
          access: access({ invocation: "serve", token: TOKEN }),
        });
        for (const query of [
          "studioMode=engineering",
          "studioMode=analysis",
          "role=product-engineer",
        ]) {
          for (const pathname of [
            `/?companion=${state.digest}&${query}`,
            `/_serverFn/getShell?companion=${state.digest}&${query}`,
            `/api/events?companion=${state.digest}&${query}`,
          ]) {
            expect((await handler(get(pathname)))!.status).toBe(401);
          }
        }
        const origin = `http://localhost:${PORT}`;
        expect((await save(handler, state, { origin })).status).toBe(401);
        expect(
          (await save(handler, state, { origin: "https://evil.test", cookie: COOKIE })).status,
        ).toBe(403);
        expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("one");
        await handler.close();
      }
    });
  });
});

describe("guards by request kind", () => {
  const origin = `http://localhost:${PORT}`;
  const credentialBroker = () => {
    const sets: string[] = [];
    const status = { kind: null, source: null } as unknown;
    return {
      sets,
      client: {
        credential: {
          status: async () => status,
          set: async (kind: string) => void sets.push(kind),
          clear: async () => void sets.push("clear"),
        },
      } as unknown as NonNullable<StudioServerDeps["factoryClient"]>,
    };
  };

  test("a write from a foreign origin is refused before it acts", async () => {
    await withFixture(async (state) => {
      const broker = credentialBroker();
      const handler = createStudioFetch(
        { ...state.deps, factoryClient: broker.client },
        { writable: true, access: access(), app: appFor(state) },
      );
      const response = (await handler(
        new Request(`http://localhost:${PORT}/api/factory/credential`, {
          method: "PUT",
          headers: { host: `localhost:${PORT}`, origin: "https://evil.test" },
          body: JSON.stringify({ kind: "api-key", value: "x" }),
        }),
      ))!;
      expect(response.status).toBe(403);
      expect(((await response.json()) as { reason: string }).reason).toContain("Studio's own page");
      expect(broker.sets).toEqual([]);
      await handler.close();
    });
  });

  test("a write without the write path is refused, naming it", async () => {
    await withFixture(async (state) => {
      const broker = credentialBroker();
      const handler = createStudioFetch(
        { ...state.deps, factoryClient: broker.client },
        { access: access({ token: TOKEN }), app: appFor(state) },
      );
      const credential = (await handler(
        new Request(`http://localhost:${PORT}/api/factory/credential`, {
          method: "DELETE",
          headers: { host: `localhost:${PORT}`, origin, cookie: COOKIE },
        }),
      ))!;
      expect(credential.status).toBe(403);
      expect(await credential.text()).toContain("--writable");
      expect(broker.sets).toEqual([]);

      // A server function's write path is checked by the services it calls.
      const saved = await save(handler, state, { origin, cookie: COOKIE });
      expect(await saved.text()).toContain("--writable");
      expect(await fs.readFile(path.join(state.root, "note.md"), "utf8")).toBe("one");
      await handler.close();
    });
  });

  test("a report publish ignores the operator token", async () => {
    await withFixture(async (state) => {
      const published: string[] = [];
      const reports = {
        cleanup: async () => {},
        publish: async (_digest: string, report: { title: string }) => {
          published.push(report.title);
          return { id: "r", title: report.title, createdAt: 0 };
        },
      };
      const handler = createStudioFetch(
        { ...state.deps, reports: reports as unknown as StudioServerDeps["reports"] },
        { terminal: true, access: access({ terminal: true, token: TOKEN }), app: appFor(state) },
      );
      const response = (await handler(
        new Request(`http://localhost:${PORT}/api/reports`, {
          method: "POST",
          headers: {
            host: `localhost:${PORT}`,
            origin,
            cookie: COOKIE,
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({ title: "t", html: "<p>x</p>" }),
        }),
      ))!;
      expect(response.status).toBe(401);
      expect(published).toEqual([]);
      await handler.close();
    });
  });

  test("a terminal call needs the terminal token; a privileged one also the origin", async () => {
    await withFixture(async (state) => {
      const handler = serve(state, {
        writable: true,
        terminal: true,
        access: access({ terminal: true, token: TOKEN }),
      });
      const end = (headers: Record<string, string>) =>
        handler(
          new Request(`http://localhost:${PORT}/api/terminal/sessions/end`, {
            method: "POST",
            headers: { host: `localhost:${PORT}`, ...headers },
            body: JSON.stringify({ id: "none" }),
          }),
        );
      expect((await end({ cookie: COOKIE, origin: "https://evil.test" }))!.status).toBe(403);
      expect((await end({ origin }))!.status).toBe(401);
      expect((await end({ origin, cookie: COOKIE }))!.status).toBe(404);
      await handler.close();
    });
  });
});
