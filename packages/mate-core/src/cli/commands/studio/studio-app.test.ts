import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadStudioApp } from "./studio-app";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-studio-build-"));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("loadStudioApp", () => {
  test("is null without a build, so the server keeps its own views", async () => {
    expect(await loadStudioApp([path.join(root, "missing")])).toBeNull();
  });

  test("loads the first build found and passes the context through", async () => {
    const dir = path.join(root, "dist");
    fs.mkdirSync(path.join(dir, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "server", "server.js"),
      "export default { fetch: (request, { context }) => new Response(String(context.studio.writable)) };",
    );
    const app = await loadStudioApp([path.join(root, "missing"), dir]);
    expect(app?.clientDir).toBe(path.join(dir, "client"));
    const response = await app!.fetch(new Request("http://localhost/"), {
      context: { studio: { writable: true } as never },
    });
    expect(await response.text()).toBe("true");
  });
});

describe("the packaged build", () => {
  test("is looked up inside the installed package, whatever the working directory", () => {
    const module = path.resolve(import.meta.dir, "studio-app.ts");
    const probe = `const { STUDIO_APP_DIRS } = await import(${JSON.stringify(module)});
console.log(STUDIO_APP_DIRS.at(-1));`;
    const run = spawnSync(process.execPath, ["-e", probe], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(path.resolve(import.meta.dir, "../../../../studio-dist"));
  });

  test("is listed among the package's published files", async () => {
    const manifest = await Bun.file(
      path.resolve(import.meta.dir, "../../../../package.json"),
    ).json();
    expect(manifest.files).toContain("studio-dist/");
    expect(manifest.scripts.prepack).toContain("studio-app/pack.ts");
  });
});

describe("the CLI's other commands", () => {
  test("load none of Studio's application", () => {
    const main = path.resolve(import.meta.dir, "../../main.ts");
    const probe = `await import(${JSON.stringify(main)});
const loaded = Object.keys(require.cache).filter((name) => /react-dom|studio-dist|mate-studio[\\\\/]dist/.test(name));
console.log(JSON.stringify(loaded));`;
    const run = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim().split("\n").at(-1)!)).toEqual([]);
  });
});
