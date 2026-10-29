import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";

import {
  companionRegistryPath,
  globalConfigPath,
  readCompanionRegistrySync,
  readGlobalCompanionsSync,
} from "./companion-registry-read";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-read-"));
  tempRoots.push(dir);
  return dir;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

describe("readGlobalCompanionsSync", () => {
  test("lists the configured companion paths", () => {
    const home = tempDir();
    write(
      globalConfigPath(home),
      stringify({ version: 1, companions: [{ path: "/acme/one" }, { path: "/acme/two" }] }),
    );

    expect(readGlobalCompanionsSync(globalConfigPath(home))).toEqual(["/acme/one", "/acme/two"]);
  });

  test("lists nothing when the configuration is missing, and writes nothing", () => {
    const home = tempDir();

    expect(readGlobalCompanionsSync(globalConfigPath(home))).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  test("lists nothing when companions is absent or not a list", () => {
    const home = tempDir();
    write(globalConfigPath(home), "version: 1\ncompanions: acme\n");

    expect(readGlobalCompanionsSync(globalConfigPath(home))).toEqual([]);
  });

  test("drops entries without a string path", () => {
    const home = tempDir();
    write(
      globalConfigPath(home),
      stringify({ version: 1, companions: [null, "acme", { path: 7 }, { path: "/acme/kept" }] }),
    );

    expect(readGlobalCompanionsSync(globalConfigPath(home))).toEqual(["/acme/kept"]);
  });

  test("throws for a configuration that does not parse", () => {
    const home = tempDir();
    write(globalConfigPath(home), "version: 1\ncompanions: [\n  - path: : :\n");

    expect(() => readGlobalCompanionsSync(globalConfigPath(home))).toThrow();
  });

  test("throws for a configuration it cannot read", () => {
    const home = tempDir();
    fs.mkdirSync(globalConfigPath(home), { recursive: true });

    expect(() => readGlobalCompanionsSync(globalConfigPath(home))).toThrow();
  });

  test("defaults to the configuration under the home folder", () => {
    expect(globalConfigPath("/home/acme")).toBe(path.join("/home/acme", ".mate", "config.yaml"));
  });
});

describe("readCompanionRegistrySync", () => {
  test("lists the linked repositories", () => {
    const companion = tempDir();
    write(companionRegistryPath(companion), "repos:\n  - id: app\n    path: /repos/app\n");

    expect(readCompanionRegistrySync(companion)).toEqual([{ id: "app", path: "/repos/app" }]);
  });

  test("lists nothing when the registry is missing", () => {
    expect(readCompanionRegistrySync(tempDir())).toEqual([]);
  });

  test("lists nothing when repos is absent", () => {
    const companion = tempDir();
    write(companionRegistryPath(companion), "version: 1\n");

    expect(readCompanionRegistrySync(companion)).toEqual([]);
  });

  test("drops entries missing an id or a path, and keeps only those two fields", () => {
    const companion = tempDir();
    write(
      companionRegistryPath(companion),
      [
        "repos:",
        "  - id: app",
        "    path: /repos/app",
        "    extra: kept-out",
        "  - path: /repos/no-id",
        "  - id: no-path",
        "  - id: 7",
        "    path: /repos/numeric-id",
        "  - null",
        "",
      ].join("\n"),
    );

    expect(readCompanionRegistrySync(companion)).toEqual([{ id: "app", path: "/repos/app" }]);
  });

  test("throws for a registry that does not parse", () => {
    const companion = tempDir();
    write(companionRegistryPath(companion), "repos: [\n  - id: : :\n");

    expect(() => readCompanionRegistrySync(companion)).toThrow();
  });

  test("throws for a registry it cannot read", () => {
    const companion = tempDir();
    fs.mkdirSync(companionRegistryPath(companion), { recursive: true });

    expect(() => readCompanionRegistrySync(companion)).toThrow();
  });

  test("names the registry under the companion's .mate/config folder", () => {
    expect(companionRegistryPath("/acme")).toBe(
      path.join("/acme", ".mate", "config", "registry.yaml"),
    );
  });
});
