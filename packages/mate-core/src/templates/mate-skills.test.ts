import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const skillsRoot = path.join(import.meta.dir, "mate-skills", "agents");
const claudeSkillsRoot = path.join(import.meta.dir, "mate-skills", "claude");
const skillNames = [
  "mate-openspec-backfill",
  "mate-interview-me",
  "mate-grill-me",
  "mate-grilling",
  "mate-grill-with-docs",
  "mate-domain-modeling",
  "mate-simplify-code",
] as const;

const attributedSkillNames = [
  "mate-interview-me",
  "mate-grill-me",
  "mate-grilling",
  "mate-grill-with-docs",
  "mate-domain-modeling",
  "mate-simplify-code",
] as const;

const attributionBySkill = {
  "mate-interview-me":
    "> Inspired by [Addy Osmani's interview-me skill](https://github.com/addyosmani/agent-skills/tree/main/skills/interview-me) and adapted here as a Mate process-driven skill.",
  "mate-grill-me":
    "> Inspired by [Matt Pocock's grill-me skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me) and adapted here as a Mate process-driven skill.",
  "mate-grilling":
    "> Inspired by [Matt Pocock's grilling skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling) and adapted here as a Mate process-driven skill.",
  "mate-grill-with-docs":
    "> Inspired by [Matt Pocock's grill-with-docs skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs) and adapted here as a Mate process-driven skill.",
  "mate-domain-modeling":
    "> Inspired by [Matt Pocock's domain-modeling skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/domain-modeling) and adapted here as a Mate process-driven skill.",
  "mate-simplify-code":
    "> Inspired by [Addy Osmani's code-simplification skill](https://github.com/addyosmani/agent-skills/tree/main/skills/code-simplification) and adapted here as a Mate process-driven skill.",
} as const;

async function readSkill(name: string): Promise<string> {
  return fs.readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
}

async function readSkillFrom(root: string, name: string): Promise<string> {
  return fs.readFile(path.join(root, name, "SKILL.md"), "utf8");
}

async function listSkillNames(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

describe("bundled Mate pre-explore skills", () => {
  test("keeps shared Mate skills outside capability-specific templates", async () => {
    await expect(
      fs.access(path.join(import.meta.dir, "capabilities", "openspec-cap")),
    ).resolves.toBeNull();
    await expect(
      fs.access(path.join(import.meta.dir, "capabilities", "openspec-cap", "mate-skills")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(import.meta.dir, "capabilities", "openspec-cap", "mate-bundled")),
    ).rejects.toThrow();
  });

  test("provides every shared agent skill in the Claude source tree", async () => {
    const sharedSkills = await listSkillNames(skillsRoot);
    const claudeSkills = await listSkillNames(claudeSkillsRoot);

    expect(claudeSkills).toEqual(expect.arrayContaining(sharedSkills));
  });

  test("keeps shared skill copies synchronized", async () => {
    for (const name of skillNames) {
      expect(await readSkillFrom(claudeSkillsRoot, name)).toBe(await readSkill(name));
    }
  });

  test("attributes each new skill in both source trees", async () => {
    for (const root of [skillsRoot, claudeSkillsRoot]) {
      for (const name of attributedSkillNames) {
        const source = await readSkillFrom(root, name);
        expect(source).toContain(attributionBySkill[name]);
      }

      const customSkill = await readSkillFrom(root, "mate-openspec-backfill");
      expect(customSkill).not.toContain("Inspired by");
    }
  });

  test("has a prefixed frontmatter name for every bundled tree", async () => {
    for (const name of skillNames) {
      const source = await readSkill(name);
      expect(source).toMatch(new RegExp(`^name: ${name}$`, "m"));
    }
  });

  test("keeps internal compositions in the Mate namespace", async () => {
    expect(await readSkill("mate-grill-me")).toContain("/mate-grilling");
    const docs = await readSkill("mate-grill-with-docs");
    expect(docs).toContain("/mate-grilling");
    expect(docs).toContain("/mate-domain-modeling");

    for (const name of skillNames) {
      const source = await readSkill(name);
      const body = source.replace(/^> Inspired by.*$/gm, "");
      expect(body).not.toMatch(
        /\/(?:grill-me|grilling|grill-with-docs|domain-modeling|interview-me)(?![a-z-])/,
      );
    }
  });

  test("keeps interview mode independent of unrelated skills", async () => {
    const source = await readSkill("mate-interview-me");
    for (const unrelated of [
      "idea-refine",
      "spec-driven-development",
      "planning-and-task-breakdown",
      "doubt-driven-development",
      "source-driven-development",
    ]) {
      expect(source).not.toContain(unrelated);
    }
    expect(source).toContain("exactly one focused question");
    expect(source).toContain("statement of intent");
    for (const marker of [
      "HYPOTHESIS:",
      "CONFIDENCE:",
      "GUESS:",
      "what would you actually want",
      "Why now:",
      "Out of scope:",
      "explicit yes",
      ">=95%",
    ]) {
      expect(source).toContain(marker);
    }
  });

  test("keeps the two pre-explore choices conversational-only", async () => {
    for (const name of ["mate-interview-me", "mate-grill-me", "mate-grilling"]) {
      const source = await readSkill(name);
      expect(source).toMatch(/does not create or modify|Do not (?:write|create)/);
      expect(source).not.toContain("mate-domain-modeling");
    }
  });

  test("requires Mate scope and selective ADRs for documentation mode", async () => {
    const domain = await readSkill("mate-domain-modeling");
    const docs = await readSkill("mate-grill-with-docs");
    for (const marker of [
      "CONTEXT-MAP.md",
      "Working Repository",
      "Area",
      "Companion Repository",
      "Do not guess",
    ]) {
      expect(domain).toContain(marker);
    }
    expect(docs).toContain("hard to reverse");
    expect(docs).toContain("genuine trade-off");
  });

  test("preserves the upstream grilling frontier discipline", async () => {
    const source = await readSkill("mate-grilling");
    expect(source).toContain("every question on the current frontier");
    expect(source).toContain("Finding facts is the agent's job");
    expect(source).toContain("shared understanding");
  });

  test("preserves the upstream simplification guardrails", async () => {
    const source = await readSkill("mate-simplify-code");
    for (const marker of [
      "Preserve Behavior Exactly",
      "Chesterton's Fence",
      "Scope to What Changed",
      "The Rule of 500",
      "All existing tests pass without modification",
      "Mate Workflow",
      "Never commit, push, or create a pull request unless the user explicitly asks",
    ]) {
      expect(source).toContain(marker);
    }
  });
});
