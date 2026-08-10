import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { YamlFileStore } from "./yaml-file-store";

interface TestData {
  value: string;
  count: number;
}

class TestStore extends YamlFileStore<TestData> {
  protected async onMissing(): Promise<TestData> {
    return { value: "default", count: 0 };
  }
}

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("YamlFileStore", () => {
  test("save writes YAML and load reads it back", async () => {
    const root = await makeTempDir("yaml-store-");
    const store = new TestStore(path.join(root, "data.yaml"));
    const data: TestData = { value: "hello", count: 42 };

    await store.save(data);
    const loaded = await store.load();

    expect(loaded).toEqual(data);
  });

  test("load calls onMissing when file does not exist", async () => {
    const root = await makeTempDir("yaml-store-missing-");
    const store = new TestStore(path.join(root, "nonexistent.yaml"));

    const loaded = await store.load();

    expect(loaded).toEqual({ value: "default", count: 0 });
  });

  test("save creates parent directories recursively", async () => {
    const root = await makeTempDir("yaml-store-mkdir-");
    const store = new TestStore(path.join(root, "a", "b", "c", "data.yaml"));

    await store.save({ value: "nested", count: 1 });

    await fs.access(path.join(root, "a", "b", "c", "data.yaml"));
  });

  test("a write interrupted before rename does not modify the existing file", async () => {
    const root = await makeTempDir("yaml-store-interrupted-");
    const configPath = path.join(root, "data.yaml");
    const store = new TestStore(configPath);
    await store.save({ value: "original", count: 1 });

    const writeFileSpy = spyOn(fs, "writeFile").mockImplementation(async () => {
      throw new Error("simulated crash before rename");
    });

    try {
      await expect(store.save({ value: "new", count: 2 })).rejects.toThrow(
        "simulated crash before rename",
      );
    } finally {
      writeFileSpy.mockRestore();
    }

    expect(await store.load()).toEqual({ value: "original", count: 1 });
    const entries = await fs.readdir(root);
    expect(entries).toEqual(["data.yaml"]);
  });
});
