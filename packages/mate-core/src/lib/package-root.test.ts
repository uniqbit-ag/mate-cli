import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { resolvePackageRoot } from "./package-root";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createEntrypoint(
  packageName: string,
  entrypoint = ["dist", "cli.mjs"],
): Promise<{ root: string; entrypoint: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-package-root-"));
  roots.push(root);
  const packageRoot = path.join(root, "distribution");
  const entrypointPath = path.join(packageRoot, ...entrypoint);
  await fs.mkdir(path.dirname(entrypointPath), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName }));
  await fs.writeFile(entrypointPath, "");
  return { root: await fs.realpath(packageRoot), entrypoint: entrypointPath };
}

describe("resolvePackageRoot", () => {
  test("resolves the published package around a nested core dependency", async () => {
    const fixture = await createEntrypoint("@uniqbit/mate");
    const coreRoot = path.join(fixture.root, "node_modules", "@uniqbit", "mate-core");
    await fs.mkdir(coreRoot, { recursive: true });
    await fs.writeFile(
      path.join(coreRoot, "package.json"),
      JSON.stringify({ name: "@uniqbit/mate-core" }),
    );

    expect(resolvePackageRoot(fixture.entrypoint, "@uniqbit/mate")).toBe(fixture.root);
  });

  test("resolves a direct development entrypoint", async () => {
    const fixture = await createEntrypoint("@uniqbit/mate", ["src", "cli.ts"]);

    expect(resolvePackageRoot(fixture.entrypoint, "@uniqbit/mate")).toBe(fixture.root);
  });

  test("canonicalizes a symlinked entrypoint before walking", async () => {
    const fixture = await createEntrypoint("@uniqbit/mate");
    const symlink = path.join(fixture.root, "mate-bin");
    await fs.symlink(fixture.entrypoint, symlink);

    expect(resolvePackageRoot(symlink, "@uniqbit/mate")).toBe(fixture.root);
  });

  test("fails closed for an unresolved entrypoint", async () => {
    const fixture = await createEntrypoint("@uniqbit/mate");

    expect(resolvePackageRoot(path.join(fixture.root, "missing"), "@uniqbit/mate")).toBeUndefined();
    expect(resolvePackageRoot(undefined, "@uniqbit/mate")).toBeUndefined();
  });

  test("fails closed when no matching package manifest exists", async () => {
    const fixture = await createEntrypoint("@acme/other");

    expect(resolvePackageRoot(fixture.entrypoint, "@uniqbit/mate")).toBeUndefined();
  });

  test("fails closed for a malformed package manifest", async () => {
    const fixture = await createEntrypoint("@uniqbit/mate");
    await fs.writeFile(path.join(fixture.root, "package.json"), "{");

    expect(resolvePackageRoot(fixture.entrypoint, "@uniqbit/mate")).toBeUndefined();
  });
});
