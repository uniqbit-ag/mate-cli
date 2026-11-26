import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { McpManagerConflictError, readMcpManager, writeMcpManager } from "./store";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const initial = [
  "# acme companion",
  "allowedAgents: [claude]",
  "capabilities:",
  "  - name: openspec # always on",
  "plugins:",
  '  - { package: "@acme/base", version: "1.0.0" }',
  "engines:",
  "  mate: '>=0.21.0'",
  "mcpManager:",
  "  servers:",
  "    acme-docs: { command: acme-docs-mcp, env: [ACME_TOKEN] }",
  "    acme-db: { command: acme-db-mcp }",
  "  enabled: { servers: [acme-docs, acme-db] }",
  "audiences:",
  "  analyst:",
  '    plugins: [{ package: "@acme/analyst", version: "1.0.0" }]',
  "    mcpManager:",
  "      disable: { servers: [acme-db] }",
  "",
].join("\n");

async function companion(text = initial): Promise<{ root: string; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-mcp-store-"));
  tempRoots.push(root);
  const file = path.join(root, ".mate", "config", "framework.yaml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
  return { root, file };
}

describe("readMcpManager", () => {
  test("returns the catalog, audience selections and effective sets", async () => {
    const { root } = await companion();
    const snapshot = await readMcpManager(root);
    expect(snapshot.catalog?.enabled).toEqual({ servers: ["acme-docs", "acme-db"] });
    expect(snapshot.audiences).toEqual({ analyst: { disable: { servers: ["acme-db"] } } });
    expect(snapshot.effective).toEqual({
      base: ["acme-db", "acme-docs"],
      audiences: { analyst: ["acme-docs"] },
    });
  });
});

describe("writeMcpManager", () => {
  test("adds a server, keeping comments and every other key", async () => {
    const { root, file } = await companion();
    const { token, catalog } = await readMcpManager(root);
    const before = parse(initial);

    await writeMcpManager(
      root,
      {
        catalog: {
          ...catalog,
          servers: { ...catalog?.servers, "acme-api": { url: "https://mcp.acme.example" } },
        },
      },
      token,
    );

    const text = await fs.readFile(file, "utf8");
    expect(text).toContain("# acme companion");
    expect(text).toContain("# always on");
    const after = parse(text);
    expect(after.mcpManager.servers["acme-api"]).toEqual({ url: "https://mcp.acme.example" });
    for (const key of ["allowedAgents", "capabilities", "plugins"]) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(after.audiences.analyst.plugins).toEqual(before.audiences.analyst.plugins);
  });

  test("raises engines.mate to the version introducing mcpManager", async () => {
    const { root, file } = await companion();
    await writeMcpManager(
      root,
      { audiences: { analyst: null } },
      (await readMcpManager(root)).token,
    );
    expect(parse(await fs.readFile(file, "utf8")).engines.mate).toBe(">=1.0.0-canary.9");
  });

  test("a stale token conflicts and leaves the file unchanged", async () => {
    const { root, file } = await companion();
    const { token } = await readMcpManager(root);
    const edited = `${initial}# edited elsewhere\n`;
    await fs.writeFile(file, edited, "utf8");

    await expect(writeMcpManager(root, { catalog: null }, token)).rejects.toBeInstanceOf(
      McpManagerConflictError,
    );
    expect(await fs.readFile(file, "utf8")).toBe(edited);
  });

  test("an env value is refused with the loader's error and leaves the file unchanged", async () => {
    const { root, file } = await companion();
    const { token } = await readMcpManager(root);
    const write = writeMcpManager(
      root,
      { catalog: { servers: { "acme-x": { command: "x", env: { ACME: "s3cr3t" } as never } } } },
      token,
    );

    await expect(write).rejects.toThrow("mcpManager.servers.acme-x: env lists variable names only");
    expect(await fs.readFile(file, "utf8")).toBe(initial);
  });
});
