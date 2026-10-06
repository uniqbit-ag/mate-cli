import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  getSharedSkillsDir,
  isSharedSkillRootActive,
  reconcileSharedSkillTree,
  removeLegacyOpenCodeSkills,
  removeSharedSkills,
  SHARED_SKILL_ROOT_RUNTIMES,
} from "./agents-skill-root";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-skill-root-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

async function seedSkill(skillsDir: string, name: string, content = `${name}\n`): Promise<void> {
  await fs.mkdir(path.join(skillsDir, name), { recursive: true });
  await fs.writeFile(path.join(skillsDir, name, "SKILL.md"), content, "utf8");
}

async function seedSource(companionPath: string): Promise<string> {
  const src = path.join(companionPath, "skill-src");
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "SKILL.md"), "acme skill\n", "utf8");
  return src;
}

describe("shared skill root runtimes", () => {
  test("only opencode reads the shared root", () => {
    expect([...SHARED_SKILL_ROOT_RUNTIMES]).toEqual(["opencode"]);
  });

  test("is active when any reading runtime is active", () => {
    expect(isSharedSkillRootActive(["claude", "opencode"])).toBe(true);
    expect(isSharedSkillRootActive(["opencode"])).toBe(true);
    expect(isSharedSkillRootActive(["claude"])).toBe(false);
    expect(isSharedSkillRootActive([])).toBe(false);
  });

  test("resolves the companion .agents/skills dir", () => {
    expect(getSharedSkillsDir("/acme")).toBe(path.join("/acme", ".agents", "skills"));
  });
});

describe("reconcileSharedSkillTree", () => {
  test("writes the tree when enabled", async () => {
    const companionPath = await makeCompanion();
    const sourceDir = await seedSource(companionPath);

    await reconcileSharedSkillTree(
      companionPath,
      { name: "acme", sourceDir },
      { enabled: true, capabilityEnabled: true, activeProviders: ["opencode"] },
    );

    expect(
      await fs.readFile(path.join(getSharedSkillsDir(companionPath), "acme", "SKILL.md"), "utf8"),
    ).toBe("acme skill\n");
  });

  test("removes the tree on capability disable and prunes empty dirs", async () => {
    const companionPath = await makeCompanion();
    const sourceDir = await seedSource(companionPath);
    await seedSkill(getSharedSkillsDir(companionPath), "acme");

    await reconcileSharedSkillTree(
      companionPath,
      { name: "acme", sourceDir },
      { enabled: false, capabilityEnabled: false, activeProviders: ["opencode"] },
    );

    expect(await exists(path.join(companionPath, ".agents"))).toBe(false);
  });

  test("keeps the tree on runtime deselect while another reading runtime is active", async () => {
    const companionPath = await makeCompanion();
    const sourceDir = await seedSource(companionPath);
    await seedSkill(getSharedSkillsDir(companionPath), "acme");

    await reconcileSharedSkillTree(
      companionPath,
      { name: "acme", sourceDir },
      { enabled: false, capabilityEnabled: true, activeProviders: ["opencode"] },
    );

    expect(await exists(path.join(getSharedSkillsDir(companionPath), "acme"))).toBe(true);
  });

  test("removes the tree on runtime deselect when no reading runtime remains", async () => {
    const companionPath = await makeCompanion();
    const sourceDir = await seedSource(companionPath);
    await seedSkill(getSharedSkillsDir(companionPath), "acme");
    await seedSkill(getSharedSkillsDir(companionPath), "acme-notes");

    await reconcileSharedSkillTree(
      companionPath,
      { name: "acme", sourceDir },
      { enabled: false, capabilityEnabled: true, activeProviders: ["claude"] },
    );

    expect(await exists(path.join(getSharedSkillsDir(companionPath), "acme"))).toBe(false);
    expect(await exists(path.join(getSharedSkillsDir(companionPath), "acme-notes"))).toBe(true);
  });

  test("removes a legacy .opencode/skills copy of the tree in every state", async () => {
    const companionPath = await makeCompanion();
    const sourceDir = await seedSource(companionPath);
    const legacyDir = path.join(companionPath, ".opencode", "skills");
    await seedSkill(legacyDir, "acme");
    await seedSkill(legacyDir, "graphify");

    await reconcileSharedSkillTree(
      companionPath,
      { name: "acme", sourceDir },
      { enabled: true, capabilityEnabled: true, activeProviders: ["opencode"] },
    );

    expect(await exists(path.join(legacyDir, "acme"))).toBe(false);
    expect(await exists(path.join(legacyDir, "graphify"))).toBe(true);
  });

  test("is idempotent", async () => {
    const companionPath = await makeCompanion();
    const sourceDir = await seedSource(companionPath);
    const state = { enabled: true, capabilityEnabled: true, activeProviders: ["opencode"] };

    await reconcileSharedSkillTree(companionPath, { name: "acme", sourceDir }, state);
    const first = await fs.readFile(
      path.join(getSharedSkillsDir(companionPath), "acme", "SKILL.md"),
    );
    await reconcileSharedSkillTree(companionPath, { name: "acme", sourceDir }, state);
    const second = await fs.readFile(
      path.join(getSharedSkillsDir(companionPath), "acme", "SKILL.md"),
    );

    expect(second.equals(first)).toBe(true);
  });
});

describe("removeSharedSkills", () => {
  test("removes only the named entries and keeps the dir when others remain", async () => {
    const companionPath = await makeCompanion();
    const skillsDir = getSharedSkillsDir(companionPath);
    await seedSkill(skillsDir, "openspec-explore");
    await seedSkill(skillsDir, "acme-notes");
    await fs.writeFile(path.join(skillsDir, ".openspec-target"), "agents\n", "utf8");

    await removeSharedSkills(companionPath, ["openspec-explore", ".openspec-target"]);

    expect(await exists(path.join(skillsDir, "openspec-explore"))).toBe(false);
    expect(await exists(path.join(skillsDir, ".openspec-target"))).toBe(false);
    expect(await exists(path.join(skillsDir, "acme-notes"))).toBe(true);
  });

  test("is silent when nothing is present", async () => {
    const companionPath = await makeCompanion();
    await removeSharedSkills(companionPath, ["openspec-explore"]);
    expect(await exists(path.join(companionPath, ".agents"))).toBe(false);
  });
});

describe("removeLegacyOpenCodeSkills", () => {
  test("deletes only managed names and keeps unmanaged trees", async () => {
    const companionPath = await makeCompanion();
    const legacyDir = path.join(companionPath, ".opencode", "skills");
    await seedSkill(legacyDir, "openspec-explore");
    await seedSkill(legacyDir, "mate-grill-me");
    await seedSkill(legacyDir, "graphify");
    await seedSkill(legacyDir, "acme-local");

    await removeLegacyOpenCodeSkills(companionPath, ["openspec-explore", "mate-grill-me"]);

    expect(await exists(path.join(legacyDir, "openspec-explore"))).toBe(false);
    expect(await exists(path.join(legacyDir, "mate-grill-me"))).toBe(false);
    expect(await exists(path.join(legacyDir, "graphify"))).toBe(true);
    expect(await exists(path.join(legacyDir, "acme-local"))).toBe(true);
  });

  test("prunes .opencode/skills when it becomes empty but keeps .opencode content", async () => {
    const companionPath = await makeCompanion();
    const legacyDir = path.join(companionPath, ".opencode", "skills");
    await seedSkill(legacyDir, "openspec-explore");
    await fs.writeFile(path.join(companionPath, ".opencode", "opencode.json"), "{}\n", "utf8");

    await removeLegacyOpenCodeSkills(companionPath, ["openspec-explore"]);

    expect(await exists(legacyDir)).toBe(false);
    expect(await exists(path.join(companionPath, ".opencode", "opencode.json"))).toBe(true);
  });

  test("is silent when the legacy dir is absent", async () => {
    const companionPath = await makeCompanion();
    await removeLegacyOpenCodeSkills(companionPath, ["openspec-explore"]);
    expect(await exists(path.join(companionPath, ".opencode"))).toBe(false);
  });
});
