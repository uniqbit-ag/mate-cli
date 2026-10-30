/** @test-requires sockets */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

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

function handlerFor(options: { writable?: boolean; token?: string } = {}) {
  return createStudioFetch(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: companion, health: "ready", pairings: [] }],
      }),
      renderDocument: () => "studio",
    },
    {
      writable: options.writable ?? true,
      ...(options.token
        ? {
            access: createStudioAccess({
              invocation: "serve",
              terminal: false,
              hostname: "localhost",
              port: () => 80,
              token: options.token,
            }),
          }
        : {}),
    },
  );
}

function post(route: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${route}`, {
    method: "POST",
    headers: { origin: "http://localhost", ...headers },
    body: new URLSearchParams(fields),
  });
}

const create = (fields: Record<string, string> = {}) =>
  post("/api/factory/worksets", {
    companion: digest,
    id: "acme-login",
    title: "Login with SSO",
    intent: "Engineers sign in with SSO.",
    repository: "acme/web",
    ...fields,
  });

const record = (id = "acme-login") =>
  parse(fs.readFileSync(path.join(companion, "worksets", `${id}.yaml`), "utf8"));

describe("creating a Workset", () => {
  test("writes the record at Clarify intent and returns to a refreshed board", async () => {
    const handler = handlerFor();
    const response = (await handler(create()))!;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/?companion=${digest}&view=factory&refresh=1`);
    expect(record()).toMatchObject({
      id: "acme-login",
      title: "Login with SSO",
      repositories: ["acme/web"],
      changes: [],
      stage: "clarify-intent",
    });
    handler.close();
  });

  test("refuses a duplicate identifier, naming it, and keeps the original", async () => {
    const handler = handlerFor();
    await handler(create());
    const response = (await handler(create({ title: "Other" })))!;
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toContain("acme-login already exists");
    expect(record().title).toBe("Login with SSO");
    handler.close();
  });

  test("refuses an invalid identifier", async () => {
    const handler = handlerFor();
    const response = (await handler(create({ id: "Acme Login" })))!;
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toContain("kebab-case");
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    handler.close();
  });

  test("refuses a repository not linked to the companion", async () => {
    const handler = handlerFor();
    const response = (await handler(create({ repository: "acme/other" })))!;
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toContain("not a Working Repository linked");
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    handler.close();
  });
});

describe("the write path guards", () => {
  test("read-only Studio refuses", async () => {
    const handler = handlerFor({ writable: false });
    expect((await handler(create()))!.status).toBe(403);
    expect(fs.existsSync(path.join(companion, "worksets"))).toBe(false);
    handler.close();
  });

  test("a missing token is refused", async () => {
    const handler = handlerFor({ token: "acme-secret-token" });
    expect((await handler(create()))!.status).toBe(401);
    handler.close();
  });

  test("a foreign origin is refused", async () => {
    const handler = handlerFor();
    const response = (await handler(
      post(
        "/api/factory/worksets",
        { companion: digest, id: "acme-login" },
        { origin: "https://evil.acme.test" },
      ),
    ))!;
    expect(response.status).toBe(403);
    handler.close();
  });

  test("only POST changes a Workset", async () => {
    const handler = handlerFor();
    const response = (await handler(new Request("http://localhost/api/factory/worksets")))!;
    expect(response.status).toBe(405);
    handler.close();
  });
});

describe("advancing a Workset", () => {
  test("moves Clarify intent to Explore change, then to ready", async () => {
    const handler = handlerFor();
    await handler(create());
    const advance = () =>
      handler(post("/api/factory/worksets/acme-login/advance", { companion: digest }));
    expect((await advance())!.status).toBe(303);
    expect(record().stage).toBe("explore");
    await advance();
    expect(record().stage).toBe("ready");
    expect((await advance())!.status).toBe(400);
    handler.close();
  });

  test("is refused once a change is linked", async () => {
    const handler = handlerFor();
    fs.mkdirSync(path.join(companion, "worksets"));
    fs.writeFileSync(
      path.join(companion, "worksets", "acme-login.yaml"),
      "id: acme-login\nrepositories: [acme/web]\nchanges: [acme-login-form]\n",
    );
    const response = (await handler(
      post("/api/factory/worksets/acme-login/advance", { companion: digest }),
    ))!;
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toContain("linked changes");
    handler.close();
  });
});
