import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { pluginPackageRoot } from "./paths";
import { verifyDeclaredPlugins } from "./verify";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function companion(
  plugins: Array<{ package: string; version: string; config?: unknown }>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-"));
  roots.push(dir);
  await fs.mkdir(path.join(dir, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".mate", "config", "framework.yaml"),
    JSON.stringify({ plugins }),
  );
  return dir;
}

async function install(dir: string, name: string, marker?: string): Promise<void> {
  const root = pluginPackageRoot(dir, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
  );
  const side = marker
    ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`
    : "";
  await fs.writeFile(
    path.join(root, "index.js"),
    `${side}export default () => ({ id: "p", kind: "capability", label: "p", description: "p",
  defaultSelected: false, isEnabled: () => true, apply: async () => {}, teardown: async () => {} });`,
  );
}

describe("verifyDeclaredPlugins", () => {
  test("passes when every declared plugin is allowed, installed and loadable", async () => {
    const dir = await companion([{ package: "@acme/reader", version: "1.0.0" }]);
    await install(dir, "@acme/reader");
    expect(await verifyDeclaredPlugins(dir, { env: { MATE_ALLOWED_PLUGINS: "@acme/*" } })).toEqual(
      [],
    );
  });

  test("an unlisted plugin is named and never executed", async () => {
    const dir = await companion([{ package: "@evil/x", version: "1.0.0" }]);
    const marker = path.join(dir, "executed");
    await install(dir, "@evil/x", marker);
    const failures = await verifyDeclaredPlugins(dir, { env: { MATE_ALLOWED_PLUGINS: "@acme/*" } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ package: "@evil/x" });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  test("an empty allowlist refuses every declared plugin", async () => {
    const dir = await companion([{ package: "@acme/reader", version: "1.0.0" }]);
    await install(dir, "@acme/reader");
    expect(await verifyDeclaredPlugins(dir, { env: { MATE_ALLOWED_PLUGINS: "" } })).toHaveLength(1);
  });

  test("a missing package says setup must install it", async () => {
    const dir = await companion([{ package: "@acme/reader", version: "1.0.0" }]);
    const failures = await verifyDeclaredPlugins(dir, { env: {} });
    expect(failures[0]?.reason).toMatch(/not installed.*install --yes --frozen-plugins/);
  });

  test("a credential from the environment loads; an unset one names the variable", async () => {
    const dir = await companion([
      { package: "@acme/reader", version: "1.0.0", config: { token: "${ACME_READ_TOKEN}" } },
    ]);
    await install(dir, "@acme/reader");
    expect(await verifyDeclaredPlugins(dir, { env: { ACME_READ_TOKEN: "t" } })).toEqual([]);
    const failures = await verifyDeclaredPlugins(dir, { env: {} });
    expect(failures[0]?.reason).toMatch(/ACME_READ_TOKEN/);
  });

  test("a malformed allowlist fails closed", async () => {
    const dir = await companion([{ package: "@acme/reader", version: "1.0.0" }]);
    const failures = await verifyDeclaredPlugins(dir, { env: { MATE_ALLOWED_PLUGINS: "@acme" } });
    expect(failures[0]?.reason).toMatch(/malformed/);
  });
});
