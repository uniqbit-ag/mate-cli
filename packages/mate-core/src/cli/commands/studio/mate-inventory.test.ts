import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { collectMateSkillNames } from "./mate-inventory";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("collectMateSkillNames", () => {
  test("reports known Mate trees once across supported runtimes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-skills-"));
    roots.push(root);
    for (const runtime of [".claude", ".opencode"]) {
      for (const name of ["mate-interview-me", "mate-grill-me", "react-doctor"]) {
        await fs.mkdir(path.join(root, runtime, "skills", name), { recursive: true });
      }
    }

    await expect(collectMateSkillNames(root)).resolves.toEqual([
      "mate-grill-me",
      "mate-interview-me",
      "react-doctor",
    ]);
  });

  test("excludes lock-file and hand-authored skill names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-studio-skills-filter-"));
    roots.push(root);
    const skillsDir = path.join(root, ".claude", "skills");
    await fs.mkdir(path.join(skillsDir, "custom-skill"), { recursive: true });
    await fs.mkdir(path.join(skillsDir, "grill-with-docs"), { recursive: true });
    await fs.writeFile(
      path.join(root, "skills-lock.json"),
      JSON.stringify({ skills: { "grill-with-docs": { source: "acme" } } }),
      "utf8",
    );

    await expect(collectMateSkillNames(root)).resolves.toEqual([]);
  });
});
