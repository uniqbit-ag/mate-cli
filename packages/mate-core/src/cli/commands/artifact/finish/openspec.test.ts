import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { openspecFinisher } from "./openspec";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-openspec-"));
  tempRoots.push(dir);
  return dir;
}

async function seedArchive(
  companionPath: string,
  folder: string,
  capabilities: string[] = [],
): Promise<void> {
  const dir = path.join(companionPath, "openspec", "changes", "archive", folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "proposal.md"), "archived\n", "utf8");
  await Promise.all(
    capabilities.map(async (capability) => {
      const specPath = path.join(dir, "specs", capability, "spec.md");
      await fs.mkdir(path.dirname(specPath), { recursive: true });
      await fs.writeFile(specPath, "delta\n", "utf8");
    }),
  );
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("openspecFinisher.detectProduced", () => {
  test("returns null when nothing is archived", async () => {
    const root = await makeCompanion();

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toBeNull();
  });

  test("finds the dated archive folder with exact active, archive, and canonical spec file paths", async () => {
    const root = await makeCompanion();
    await seedArchive(root, "2026-07-14-my-change", ["z-capability", "a-capability"]);

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toEqual({
      anchorName: "2026-07-14-my-change",
      commitPaths: [
        "openspec/changes/my-change",
        "openspec/changes/archive/2026-07-14-my-change",
        "openspec/specs/a-capability/spec.md",
        "openspec/specs/z-capability/spec.md",
      ],
    });
  });

  test("includes nested delta spec files without staging their entire canonical capability", async () => {
    const root = await makeCompanion();
    const folder = "2026-07-14-my-change";
    await seedArchive(root, folder, ["my-capability"]);
    const nested = path.join(
      root,
      "openspec",
      "changes",
      "archive",
      folder,
      "specs",
      "my-capability",
      "examples",
      "example.md",
    );
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, "example\n", "utf8");

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toEqual({
      anchorName: folder,
      commitPaths: [
        "openspec/changes/my-change",
        `openspec/changes/archive/${folder}`,
        "openspec/specs/my-capability/examples/example.md",
        "openspec/specs/my-capability/spec.md",
      ],
    });
  });

  test("does not match a different change name", async () => {
    const root = await makeCompanion();
    await seedArchive(root, "2026-07-14-other-change");

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toBeNull();
  });

  test("picks the latest dated folder when a name was archived twice", async () => {
    const root = await makeCompanion();
    await seedArchive(root, "2025-01-01-my-change");
    await seedArchive(root, "2026-07-14-my-change");

    await expect(openspecFinisher(root).detectProduced("my-change")).resolves.toEqual({
      anchorName: "2026-07-14-my-change",
      commitPaths: ["openspec/changes/my-change", "openspec/changes/archive/2026-07-14-my-change"],
    });
  });

  test("is enabled only when the openspec capability is present", async () => {
    const finisher = openspecFinisher("/companion");

    expect(finisher.isEnabled([{ name: "openspec" }])).toBe(true);
    expect(finisher.isEnabled([{ name: "graphify" }])).toBe(false);
  });
});
