import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";

import type { McpManagerState } from "./mcp-manager";
import { companionDigest } from "./selection";
import { createStudioFetch } from "./server";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const initial = [
  "allowedAgents: [claude]",
  "mcpManager:",
  "  servers:",
  "    acme-docs: { command: acme-docs-mcp, env: [ACME_TOKEN] }",
  '    acme-api: { url: "https://acme.test/mcp", headers: { Authorization: "Bearer ${ACME_KEY}" } }',
  "    acme-db: { command: acme-db-mcp }",
  "  groups:",
  "    acme-data: [acme-api, acme-db]",
  "  enabled: { servers: [acme-docs], groups: [acme-data] }",
  "audiences:",
  "  analyst:",
  "    mcpManager:",
  "      disable: { servers: [acme-db] }",
  "",
].join("\n");

const SECRET = "acme-secret-value";

async function studio(options: { writable?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-mcp-"));
  tempRoots.push(root);
  const file = path.join(root, ".mate", "config", "framework.yaml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, initial, "utf8");
  const handler = createStudioFetch(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: root, health: "ready", pairings: [] }],
      }),
      services: [],
      env: { ACME_TOKEN: SECRET },
    },
    options,
  );
  return { file, digest: companionDigest(root), services: handler.services };
}

/** The state the view sends after deleting `acme-db` and its references. */
const withoutDb: McpManagerState = {
  catalog: {
    servers: {
      "acme-docs": { command: "acme-docs-mcp", env: ["ACME_TOKEN"] },
      "acme-api": {
        url: "https://acme.test/mcp",
        headers: { Authorization: "Bearer ${ACME_KEY}" },
      },
    },
    groups: { "acme-data": ["acme-api"] },
    enabled: { servers: ["acme-docs"], groups: ["acme-data"] },
  },
  audiences: { analyst: {} },
};

describe("Studio mcpManager services", () => {
  test("the view names each variable with its set state and carries no value", async () => {
    const { digest, services } = await studio();
    const view = await services.mcpManager(digest);
    expect(view.variables).toEqual({
      "acme-docs": [{ name: "ACME_TOKEN", set: true }],
      "acme-api": [{ name: "ACME_KEY", set: false }],
      "acme-db": [],
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  test("a preview resolves unsaved state and reports core's validation error", async () => {
    const { digest, services } = await studio();
    expect(await services.mcpManagerPreview(digest, withoutDb)).toMatchObject({
      ok: true,
      effective: {
        base: ["acme-api", "acme-docs"],
        audiences: { analyst: ["acme-api", "acme-docs"] },
      },
    });
    const invalid = await services.mcpManagerPreview(digest, {
      catalog: { servers: { "acme-docs": { command: "acme-docs-mcp", env: ["acme token"] } } },
      audiences: {},
    });
    expect(invalid).toMatchObject({ ok: false, reason: expect.stringContaining("variable name") });
  });

  test("a read-only Studio refuses the save and writes nothing", async () => {
    const { file, digest, services } = await studio();
    const { token } = await services.mcpManager(digest);
    await expect(services.mcpManagerSave(digest, withoutDb, token)).rejects.toThrow("--writable");
    expect(await fs.readFile(file, "utf8")).toBe(initial);
  });

  test("a stale token is a conflict with the current view and writes nothing", async () => {
    const { file, digest, services } = await studio({ writable: true });
    const { token } = await services.mcpManager(digest);
    const changed = initial.replace("acme-docs-mcp", "acme-docs-next");
    await fs.writeFile(file, changed, "utf8");
    const result = await services.mcpManagerSave(digest, withoutDb, token);
    expect(result).toMatchObject({
      kind: "conflict",
      current: { catalog: { servers: { "acme-docs": { command: "acme-docs-next" } } } },
    });
    expect(await fs.readFile(file, "utf8")).toBe(changed);
  });

  test("a save removes a deleted server and every reference to it", async () => {
    const { file, digest, services } = await studio({ writable: true });
    const { token } = await services.mcpManager(digest);
    const result = await services.mcpManagerSave(digest, withoutDb, token);
    expect(result).toMatchObject({ kind: "saved", view: { audiences: { analyst: {} } } });
    const text = await fs.readFile(file, "utf8");
    expect(text).not.toContain("acme-db");
    expect(parse(text).audiences).toEqual({ analyst: {} });
  });
});
