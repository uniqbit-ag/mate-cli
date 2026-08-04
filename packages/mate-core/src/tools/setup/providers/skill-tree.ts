import fs from "node:fs/promises";
import path from "node:path";

// Escape-hatch support: patch markdown files of a skill tree that an external
// CLI wrote into a runtime directory (SKILL.md plus references/*.md).
// Directory-driven so reference files added by future releases are covered.

async function patchMarkdownFile(
  filePath: string,
  transform: (content: string) => string,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return; // file absent — nothing to patch
  }
  const rewritten = transform(content);
  if (rewritten !== content) await fs.writeFile(filePath, rewritten, "utf8");
}

export async function patchSkillTreeMarkdownFiles(
  skillDir: string,
  transform: (content: string) => string,
  excludeFiles: ReadonlySet<string> = new Set(),
): Promise<void> {
  await patchMarkdownFile(path.join(skillDir, "SKILL.md"), transform);

  const refsDir = path.join(skillDir, "references");
  let entries: string[];
  try {
    entries = await fs.readdir(refsDir);
  } catch {
    return; // no references/ dir
  }
  const targets = entries.filter((name) => name.endsWith(".md") && !excludeFiles.has(name));
  await Promise.all(targets.map((name) => patchMarkdownFile(path.join(refsDir, name), transform)));
}
