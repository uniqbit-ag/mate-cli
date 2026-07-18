import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { injectSchemaForBrokenOpenSpecCommands, readOpenSpecProjectSchema } from "./openspec";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readOpenSpecProjectSchema", () => {
  test("reads schema from companion-local openspec config", async () => {
    const root = await makeTempDir("mate-cap-openspec-schema-");
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    await fs.writeFile(path.join(root, "openspec", "config.yaml"), "schema: mate-v1\n", "utf8");

    expect(readOpenSpecProjectSchema(root)).toBe("mate-v1");
  });
});

describe("injectSchemaForBrokenOpenSpecCommands", () => {
  test("injects project schema for templates when --schema is absent", () => {
    expect(injectSchemaForBrokenOpenSpecCommands(["templates", "--json"], "mate-v1")).toEqual([
      "templates",
      "--schema",
      "mate-v1",
      "--json",
    ]);
  });

  test("does not inject for other commands", () => {
    expect(injectSchemaForBrokenOpenSpecCommands(["update", "--force"], "mate-v1")).toEqual([
      "update",
      "--force",
    ]);
  });

  test("does not override explicit schema", () => {
    expect(
      injectSchemaForBrokenOpenSpecCommands(
        ["templates", "--schema", "spec-driven", "--json"],
        "mate-v1",
      ),
    ).toEqual(["templates", "--schema", "spec-driven", "--json"]);
  });
});
