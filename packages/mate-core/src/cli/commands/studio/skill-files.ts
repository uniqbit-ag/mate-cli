import fs from "node:fs/promises";
import path from "node:path";

import { SKILL_DIRS, type StudioSkillInventory } from "./mate-inventory";
import { codeTree, markdownTree, type MdNode } from "./views/vault/markdown-tree";

export type SkillAgent = keyof StudioSkillInventory;

export interface SkillFileEntry {
  /** Relative to the skill's folder, `/`-separated. */
  path: string;
  size: number;
}

export interface SkillPreview {
  files: SkillFileEntry[];
  /** More files than listed were found. */
  truncated: boolean;
  /** The file shown: SKILL.md unless another was asked for; `null` when the folder is empty. */
  open: { path: string; nodes: MdNode[] | null; note: string | null } | null;
}

export interface SkillPreviewFs {
  readdir: (dir: string) => Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]>;
  realpath: (target: string) => Promise<string>;
  stat: (target: string) => Promise<{ size: number }>;
  readFile: (target: string) => Promise<Buffer>;
}

/** A refusal Studio shows as it is; nothing was read. */
export class SkillPreviewError extends Error {}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_FILES = 200;
const MAX_DEPTH = 4;
const MAX_BYTES = 256 * 1024;
const SKIPPED = new Set([".git", "node_modules", ".DS_Store"]);
const MARKDOWN = /\.(md|markdown)$/i;

const defaultFs: SkillPreviewFs = {
  readdir: (dir) => fs.readdir(dir, { withFileTypes: true }),
  realpath: (target) => fs.realpath(target),
  stat: (target) => fs.stat(target),
  readFile: (target) => fs.readFile(target),
};

const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Every file under the skill's folder, bounded, skipping links that leave it. */
async function listFiles(
  skillFs: SkillPreviewFs,
  root: string,
): Promise<{ files: SkillFileEntry[]; truncated: boolean }> {
  const files: SkillFileEntry[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const entries = await skillFs.readdir(dir).catch(() => []);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name)) continue;
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      // oxlint-disable-next-line no-await-in-loop -- sorted, bounded walk
      const resolved = await skillFs.realpath(path.join(dir, entry.name)).catch(() => null);
      if (resolved === null || !inside(root, resolved)) continue;
      if (entry.isDirectory()) {
        // oxlint-disable-next-line no-await-in-loop -- sorted, bounded walk
        if (depth < MAX_DEPTH) await walk(resolved, relative, depth + 1);
      } else if (entry.isFile()) {
        // oxlint-disable-next-line no-await-in-loop -- sorted, bounded walk
        const { size } = await skillFs.stat(resolved);
        files.push({ path: relative, size });
      }
    }
  };
  await walk(root, "", 0);
  // SKILL.md first: it is what the agent reads.
  files.sort((a, b) => Number(b.path === "SKILL.md") - Number(a.path === "SKILL.md"));
  return { files, truncated };
}

async function render(
  skillFs: SkillPreviewFs,
  root: string,
  file: SkillFileEntry,
  vaultPath: string,
): Promise<{ nodes: MdNode[] | null; note: string | null }> {
  if (file.size > MAX_BYTES) return { nodes: null, note: "Too large to preview." };
  const bytes = await skillFs.readFile(path.join(root, ...file.path.split("/")));
  if (bytes.includes(0)) return { nodes: null, note: "A binary file; not previewed." };
  const text = bytes.toString("utf8");
  if (MARKDOWN.test(file.path)) return { nodes: markdownTree(text, vaultPath), note: null };
  const extension = path.extname(file.path).slice(1).toLowerCase() || undefined;
  return { nodes: codeTree(text, extension), note: null };
}

/**
 * One installed skill's files and one of them rendered, read-only. Only a listed file is read,
 * so a request never names a path outside the skill's own folder.
 */
export async function readSkillPreview(
  companionPath: string,
  agent: SkillAgent,
  name: string,
  file?: string,
  skillFs: SkillPreviewFs = defaultFs,
): Promise<SkillPreview> {
  if (!Object.hasOwn(SKILL_DIRS, agent)) throw new SkillPreviewError("unknown agent");
  if (!SKILL_NAME.test(name)) throw new SkillPreviewError("not a skill name");
  const skillsDir = path.join(companionPath, SKILL_DIRS[agent], "skills");
  const root = await skillFs.realpath(path.join(skillsDir, name)).catch(() => null);
  const companionRoot = await skillFs.realpath(companionPath);
  if (root === null || !inside(companionRoot, root)) {
    throw new SkillPreviewError(`${name} is not installed for this agent`);
  }
  const { files, truncated } = await listFiles(skillFs, root);
  const shown = file === undefined ? files[0] : files.find((entry) => entry.path === file);
  if (file !== undefined && shown === undefined) {
    throw new SkillPreviewError(`${file} is not a file of ${name}`);
  }
  if (!shown) return { files, truncated, open: null };
  const vaultPath = `${SKILL_DIRS[agent]}/skills/${name}/${shown.path}`;
  return {
    files,
    truncated,
    open: { path: shown.path, ...(await render(skillFs, root, shown, vaultPath)) },
  };
}
