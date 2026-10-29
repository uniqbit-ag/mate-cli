import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openSpecCliDeps } from "../openspec-cli";
import {
  checkStoreRegistration,
  deriveStoreId,
  ensureStoreRegistration,
  openSpecDataDir,
  openSpecStoreDeps,
} from "./openspec-store";
import {
  openSpecRegistryPath as registryPath,
  stubOpenSpec,
  writeOpenSpecRegistry as writeRegistry,
} from "../../../test/openspec-store-stub";

const tempRoots: string[] = [];
const originalDeps = { ...openSpecStoreDeps };
const originalCliDeps = { ...openSpecCliDeps };

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

/** A companion that is an OpenSpec root, named so its store id is predictable. */
async function makeCompanion(root: string, name = "acme-companion"): Promise<string> {
  const companion = path.join(root, name);
  await fs.mkdir(path.join(companion, "openspec"), { recursive: true });
  await fs.writeFile(path.join(companion, "openspec", "config.yaml"), "schema: mate-v1\n");
  return companion;
}

let dataHome: string;

beforeEach(async () => {
  dataHome = await makeTempDir("openspec-store-data-");
  openSpecStoreDeps.env = () => ({ XDG_DATA_HOME: dataHome });
});

afterEach(async () => {
  Object.assign(openSpecStoreDeps, originalDeps);
  Object.assign(openSpecCliDeps, originalCliDeps);
  for (const dir of tempRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("deriveStoreId", () => {
  test("uses the companion folder name", async () => {
    const root = await makeTempDir("openspec-store-id-");
    expect(await deriveStoreId(await makeCompanion(root))).toBe("acme-companion");
  });

  test("sanitizes a folder name into a kebab-case id", async () => {
    const root = await makeTempDir("openspec-store-id-");
    expect(await deriveStoreId(await makeCompanion(root, "Acme_Companion..v2"))).toBe(
      "acme-companion-v2",
    );
  });

  test("prefers the id recorded in the companion's local store metadata", async () => {
    const root = await makeTempDir("openspec-store-id-");
    const companion = await makeCompanion(root);
    await fs.mkdir(path.join(companion, ".openspec-store"));
    await fs.writeFile(
      path.join(companion, ".openspec-store", "store.yaml"),
      "version: 1\nid: team-plans\n",
    );
    expect(await deriveStoreId(companion)).toBe("team-plans");
  });

  test("rejects a folder name that sanitizes to nothing", async () => {
    const root = await makeTempDir("openspec-store-id-");
    await expect(deriveStoreId(await makeCompanion(root, "___"))).rejects.toThrow(/store id/);
  });
});

describe("openSpecDataDir", () => {
  test("XDG_DATA_HOME wins on every platform", () => {
    expect(openSpecDataDir({ XDG_DATA_HOME: "/xdg" }, "win32", "/home/u")).toBe(
      path.join("/xdg", "openspec"),
    );
  });

  test("Windows falls back to LOCALAPPDATA", () => {
    expect(openSpecDataDir({ LOCALAPPDATA: "C:\\Local" }, "win32", "/home/u")).toBe(
      path.join("C:\\Local", "openspec"),
    );
  });

  test("Unix falls back to ~/.local/share", () => {
    expect(openSpecDataDir({}, "darwin", "/home/u")).toBe(
      path.join("/home/u", ".local", "share", "openspec"),
    );
  });
});

describe("checkStoreRegistration", () => {
  test("registered when the id maps to the companion", async () => {
    const root = await makeTempDir("openspec-store-check-");
    const companion = await makeCompanion(root);
    await writeRegistry(dataHome, { "acme-companion": companion });
    expect(await checkStoreRegistration(companion, "acme-companion")).toEqual({
      state: "registered",
    });
  });

  test("absent without a registry file or without the id", async () => {
    const root = await makeTempDir("openspec-store-check-");
    const companion = await makeCompanion(root);
    expect(await checkStoreRegistration(companion, "acme-companion")).toEqual({ state: "absent" });
    await writeRegistry(dataHome, { other: "/elsewhere" });
    expect(await checkStoreRegistration(companion, "acme-companion")).toEqual({ state: "absent" });
  });

  test("conflict names the path the id is registered to", async () => {
    const root = await makeTempDir("openspec-store-check-");
    const companion = await makeCompanion(root);
    await writeRegistry(dataHome, { "acme-companion": "/somewhere/else" });
    expect(await checkStoreRegistration(companion, "acme-companion")).toEqual({
      state: "conflict",
      path: "/somewhere/else",
    });
  });

  test("unreadable when the registry does not parse", async () => {
    const root = await makeTempDir("openspec-store-check-");
    const companion = await makeCompanion(root);
    await fs.mkdir(path.dirname(registryPath(dataHome)), { recursive: true });
    await fs.writeFile(registryPath(dataHome), "stores: [\n");
    expect(await checkStoreRegistration(companion, "acme-companion")).toEqual({
      state: "unreadable",
    });
  });
});

describe("ensureStoreRegistration", () => {
  test("registers a missing store through the real binary", async () => {
    const root = await makeTempDir("openspec-store-ensure-");
    const companion = await makeCompanion(root);
    const stub = await stubOpenSpec(root, dataHome);
    openSpecCliDeps.locate = () => ({ bin: stub.bin });

    expect(await ensureStoreRegistration(companion)).toEqual({
      state: "written",
      id: "acme-companion",
    });
    expect(await stub.calls()).toEqual([`store register ${companion} --id acme-companion --yes`]);
    expect(await checkStoreRegistration(companion, "acme-companion")).toEqual({
      state: "registered",
    });
  });

  test("an existing registration is current and spawns nothing", async () => {
    const root = await makeTempDir("openspec-store-ensure-");
    const companion = await makeCompanion(root);
    await writeRegistry(dataHome, { "acme-companion": companion });
    const stub = await stubOpenSpec(root, dataHome);
    openSpecCliDeps.locate = () => ({ bin: stub.bin });

    expect(await ensureStoreRegistration(companion)).toEqual({
      state: "current",
      id: "acme-companion",
    });
    expect(await stub.calls()).toEqual([]);
  });

  test("an unreadable registry falls through to registering", async () => {
    const root = await makeTempDir("openspec-store-ensure-");
    const companion = await makeCompanion(root);
    await fs.mkdir(path.dirname(registryPath(dataHome)), { recursive: true });
    await fs.writeFile(registryPath(dataHome), "stores: [\n");
    const stub = await stubOpenSpec(root, dataHome);
    openSpecCliDeps.locate = () => ({ bin: stub.bin });

    expect((await ensureStoreRegistration(companion)).state).toBe("written");
    expect(await stub.calls()).toHaveLength(1);
  });

  test("an id taken by another path fails, naming it, and spawns nothing", async () => {
    const root = await makeTempDir("openspec-store-ensure-");
    const companion = await makeCompanion(root);
    await writeRegistry(dataHome, { "acme-companion": "/somewhere/else" });
    const stub = await stubOpenSpec(root, dataHome);
    openSpecCliDeps.locate = () => ({ bin: stub.bin });

    await expect(ensureStoreRegistration(companion)).rejects.toThrow("/somewhere/else");
    expect(await stub.calls()).toEqual([]);
  });

  test("a missing binary is skipped", async () => {
    const root = await makeTempDir("openspec-store-ensure-");
    const companion = await makeCompanion(root);
    openSpecCliDeps.locate = () => ({ missing: "bundled OpenSpec CLI is missing." });

    expect((await ensureStoreRegistration(companion)).state).toBe("skipped");
  });

  test("a failing registration reports OpenSpec's message", async () => {
    const root = await makeTempDir("openspec-store-ensure-");
    const companion = await makeCompanion(root);
    const stub = await stubOpenSpec(root, dataHome, { stderr: "Store registry is busy." });
    openSpecCliDeps.locate = () => ({ bin: stub.bin });

    await expect(ensureStoreRegistration(companion)).rejects.toThrow("Store registry is busy.");
  });

  test("a companion that is no OpenSpec root is skipped without a spawn", async () => {
    const root = await makeTempDir("openspec-store-ensure-");
    const companion = path.join(root, "bare-companion");
    await fs.mkdir(companion);
    const stub = await stubOpenSpec(root, dataHome);
    openSpecCliDeps.locate = () => ({ bin: stub.bin });

    expect((await ensureStoreRegistration(companion)).state).toBe("skipped");
    expect(await stub.calls()).toEqual([]);
  });
});

describe("the registration environment", () => {
  test("runs with telemetry and update checks off, over the injected environment", async () => {
    const root = await makeTempDir("openspec-store-env-");
    const companion = await makeCompanion(root);
    const log = path.join(root, "env.log");
    const bin = path.join(root, "openspec");
    await fs.writeFile(
      bin,
      `#!/usr/bin/env bash\nenv | grep -E "^(OPENSPEC_|XDG_DATA_HOME)" | sort > "${log}"\n`,
    );
    await fs.chmod(bin, 0o755);
    openSpecCliDeps.locate = () => ({ bin });

    expect((await ensureStoreRegistration(companion)).state).toBe("written");
    expect((await fs.readFile(log, "utf8")).trim().split("\n")).toEqual([
      "OPENSPEC_NO_UPDATE_CHECK=1",
      "OPENSPEC_TELEMETRY=0",
      `XDG_DATA_HOME=${dataHome}`,
    ]);
  });
});
