import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { companionSession, companionSkills } from "./companion-context";

let companion: string;

beforeEach(() => {
  companion = fs.mkdtempSync(path.join(os.tmpdir(), "mate-companion-context-"));
});

afterEach(() => fs.rmSync(companion, { recursive: true, force: true }));

function write(relative: string, content: string | Uint8Array): void {
  const file = path.join(companion, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

describe("companion skills", () => {
  test("loads each skill with its description and text files, sorted", async () => {
    write(
      ".claude/skills/mate-propose-change/SKILL.md",
      skill("mate-propose-change", "Propose acme."),
    );
    write(".claude/skills/mate-propose-change/references/openspec-propose.md", "# Propose\n");
    write(".claude/skills/mate-propose-change/logo.png", new Uint8Array([137, 80, 0, 71]));
    write(".claude/skills/acme-review/SKILL.md", skill("acme-review", "Review acme."));

    const skills = await companionSkills(companion);
    expect(skills.map((entry) => entry.name)).toEqual(["acme-review", "mate-propose-change"]);
    expect(skills[1]).toEqual({
      name: "mate-propose-change",
      description: '"Propose acme."',
      content: "# mate-propose-change\n",
      files: [{ path: "references/openspec-propose.md", content: "# Propose\n" }],
    });
  });

  test("a description with a colon survives the harness's unquoted frontmatter", async () => {
    write(".claude/skills/acme-review/SKILL.md", skill("acme-review", '"Review: acme\n  code."'));
    const [loaded] = await companionSkills(companion);
    const rendered = `---\nname: acme-review\ndescription: ${loaded!.description}\n---\n`;
    expect(Bun.YAML.parse(rendered.split("---")[1]!)).toEqual({
      name: "acme-review",
      description: "Review: acme code.",
    });
  });

  test("skips a directory without a described SKILL.md or with an invalid name", async () => {
    write(".claude/skills/acme-empty/notes.md", "no skill here\n");
    write(".claude/skills/acme-bare/SKILL.md", "# no frontmatter\n");
    write(".claude/skills/Acme_Bad/SKILL.md", skill("Acme_Bad", "Bad name."));
    expect(await companionSkills(companion)).toEqual([]);
  });

  test("a companion without skills has none", async () => {
    expect(await companionSkills(companion)).toEqual([]);
  });
});

describe("companion session", () => {
  const repository = { id: "acme/web", path: "/var/lib/mate-factory/worktrees/acme-greet" };

  test("instructions are the companion policy for the Workset's worktree, then AGENTS.md", async () => {
    write("AGENTS.md", "- Use acme names in examples.\n");
    const { instructions } = await companionSession(companion, repository);
    expect(instructions).toContain('<companion-policy framework="mate" priority="mandatory">');
    expect(instructions).toContain(repository.path);
    expect(instructions).toContain(companion);
    expect(instructions.trimEnd().endsWith("- Use acme names in examples.")).toBe(true);
  });

  test("instructions are the policy alone without an AGENTS.md", async () => {
    const { instructions } = await companionSession(companion, repository);
    expect(instructions).toContain("<companion-policy");
    expect(instructions).not.toContain("acme names");
  });

  test("the environment is what the wrappers read, with the wrapper bin first on PATH", async () => {
    const { env } = await companionSession(companion, repository);
    expect(env.MATE_ARTIFACT_PATH).toBe(companion);
    expect(env.MATE_REPO_PATH).toBe(repository.path);
    expect(env.PATH!.startsWith(`${env.MATE_WRAPPER_BIN_PATH}:`)).toBe(true);
    expect(env.PATH).toEndWith(":/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  });
});
