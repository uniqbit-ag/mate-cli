import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { collectSkillInventory } from "./mate-inventory";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("collectSkillInventory", () => {
  test("reports every skill separately for each supported runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-skills-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".claude", "skills", "custom-skill"), { recursive: true });
    await fs.mkdir(path.join(root, ".claude", "skills", "shared-skill"), { recursive: true });
    await fs.mkdir(path.join(root, ".opencode", "skills", "shared-skill"), { recursive: true });
    await fs.mkdir(path.join(root, ".opencode", "skills", "runtime-only"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "shared-agent-skill"), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, ".claude", "skills", "not-a-skill"), "", "utf8");

    await expect(collectSkillInventory(root)).resolves.toEqual({
      claude: ["custom-skill", "shared-skill"],
      opencode: ["runtime-only", "shared-skill"],
      agents: ["shared-agent-skill"],
    });
  });

  test("returns an empty list when a runtime has no skill tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-skills-filter-"));
    roots.push(root);

    await expect(collectSkillInventory(root)).resolves.toEqual({
      claude: [],
      opencode: [],
      agents: [],
    });
  });
});
