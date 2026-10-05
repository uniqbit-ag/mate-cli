import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { registerCompanionAccess } from "./add-dir";

type Hook = (event: Record<string, unknown>) => unknown;
type SkillRecord = Record<string, unknown> & { id: string };

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function fakeApi(existingSkills: SkillRecord[] = []) {
  const hooks = new Map<string, Hook>();
  const skills = new Map(existingSkills.map((skill) => [skill.id, skill]));
  const api = {
    permission: {
      hook: async (name: string, callback: Hook) => {
        hooks.set(`permission.${name}`, callback);
      },
    },
    skill: {
      transform: async (
        transform: (editor: {
          get: (id: string) => SkillRecord | undefined;
          add: (skill: SkillRecord) => void;
          update: (id: string, update: (skill: SkillRecord) => void) => void;
        }) => void,
      ) => {
        transform({
          get: (id) => skills.get(id),
          add: (skill) => skills.set(skill.id, skill),
          update: (id, update) => {
            const skill = skills.get(id);
            if (skill) update(skill);
          },
        });
      },
    },
  };
  return { api: api as never, hooks, skills };
}

function writeSkill(root: string, name: string, frontmatter: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\n${frontmatter}\n---\nbody\n`, "utf8");
  return file;
}

describe("companion access registration", () => {
  test("allows evaluations that touch the companion and keeps every other verdict", async () => {
    const companion = tempDir("mate-add-dir-");
    const { api, hooks } = fakeApi();
    await registerCompanionAccess(api, companion);
    const evaluate = hooks.get("permission.evaluate")!;

    const inside = {
      resources: [path.join(companion, "notes.md")],
      effect: "ask",
      message: "external directory",
    };
    await evaluate(inside);
    expect(inside).toEqual({ resources: inside.resources, effect: "allow" });

    const root = { resources: [companion], effect: "ask" };
    await evaluate(root);
    expect(root.effect).toBe("allow");

    const outside = { resources: [`${companion}-sibling/notes.md`, "/tmp/acme"], effect: "deny" };
    await evaluate(outside);
    expect(outside.effect).toBe("deny");
  });

  test("registers companion skills from both skill roots", async () => {
    const companion = tempDir("mate-add-dir-skills-");
    const agentsSkill = writeSkill(
      path.join(companion, ".agents", "skills"),
      "acme-review",
      'name: acme-review\ndescription: "Review acme changes"',
    );
    const opencodeSkill = writeSkill(
      path.join(companion, ".opencode", "skills", "nested"),
      "Acme Plan",
      "description: Plan acme work",
    );
    const { api, skills } = fakeApi();

    await registerCompanionAccess(api, companion);

    expect(skills.get("acme-review")).toMatchObject({
      name: "acme-review",
      description: "Review acme changes",
      path: agentsSkill,
    });
    expect(skills.get("acme-plan")).toMatchObject({
      name: "Acme Plan",
      description: "Plan acme work",
      path: opencodeSkill,
    });
  });

  test("updates a skill OpenCode already registered under the same id", async () => {
    const companion = tempDir("mate-add-dir-update-");
    writeSkill(path.join(companion, ".agents", "skills"), "acme", "name: acme");
    const existing = { id: "acme", name: "acme", origin: "host" };
    const { api, skills } = fakeApi([existing]);

    await registerCompanionAccess(api, companion);

    expect(skills.get("acme")).toBe(existing);
    expect(existing).toMatchObject({ origin: "host", content: expect.stringContaining("body") });
  });

  test("leaves skills untouched when the companion has none", async () => {
    const companion = tempDir("mate-add-dir-empty-");
    const { api, skills } = fakeApi();

    await registerCompanionAccess(api, companion);

    expect(skills.size).toBe(0);
  });

  test("spells no MATE_ variable name of its own", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "add-dir.ts"), "utf8");

    expect(source).not.toContain("MATE_");
  });
});
