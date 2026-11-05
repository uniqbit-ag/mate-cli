import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readSkillPreview, SkillPreviewError } from "./skill-files";

let companion: string;
let outside: string;

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-companion-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "acme-outside-"));
  const skill = path.join(companion, ".claude", "skills", "acme-skill");
  await fs.mkdir(path.join(skill, "references"), { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: acme-skill\n---\n# Acme\n");
  await fs.writeFile(path.join(skill, "references", "notes.md"), "Notes");
  await fs.writeFile(path.join(skill, "run.sh"), "echo acme\n");
  await fs.writeFile(path.join(skill, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await fs.writeFile(path.join(outside, "secret.md"), "outside");
  await fs.symlink(path.join(outside, "secret.md"), path.join(skill, "leak.md"));
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("readSkillPreview", () => {
  it("lists the skill's files, SKILL.md first, and renders it", async () => {
    const preview = await readSkillPreview(companion, "claude", "acme-skill");
    expect(preview.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "logo.png",
      "references/notes.md",
      "run.sh",
    ]);
    expect(preview.open?.path).toBe("SKILL.md");
    expect(JSON.stringify(preview.open?.nodes)).toContain('"md-frontmatter"');
  });

  it("shows another text file as code and a binary one as a note", async () => {
    const script = await readSkillPreview(companion, "claude", "acme-skill", "run.sh");
    expect(JSON.stringify(script.open?.nodes)).toContain("md-fence");
    const image = await readSkillPreview(companion, "claude", "acme-skill", "logo.png");
    expect(image.open).toMatchObject({ nodes: null, note: "A binary file; not previewed." });
  });

  it("never reads a file outside the skill's folder", async () => {
    const preview = await readSkillPreview(companion, "claude", "acme-skill");
    expect(preview.files.map((file) => file.path)).not.toContain("leak.md");
    await expect(
      readSkillPreview(companion, "claude", "acme-skill", "../../../.mate/config.yaml"),
    ).rejects.toBeInstanceOf(SkillPreviewError);
    await expect(readSkillPreview(companion, "claude", "../acme")).rejects.toBeInstanceOf(
      SkillPreviewError,
    );
    await expect(readSkillPreview(companion, "opencode", "acme-skill")).rejects.toBeInstanceOf(
      SkillPreviewError,
    );
  });
});
