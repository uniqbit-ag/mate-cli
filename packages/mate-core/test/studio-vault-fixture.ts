/**
 * Large fixture companion for profiling Studio's vault tree.
 *
 * Usage: `bun test/studio-vault-fixture.ts <directory> [fileCount=5000]`
 * Writes `fileCount` markdown files into nested folders and `git init`s it, so
 * Studio lists it through Git as it does a real companion. With `--measure`,
 * also prints the vault page's tree markup size for that file count.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { VaultTreeNode } from "../src/cli/commands/studio/vault";

const FILES_PER_FOLDER = 20;
const FOLDERS_PER_LEVEL = 10;

/** `area-N/group-N/note-N.md`: many folders, shallow depth, stable order. */
export function fixturePaths(fileCount: number): string[] {
  const paths: string[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    const folder = Math.floor(index / FILES_PER_FOLDER);
    const group = folder % FOLDERS_PER_LEVEL;
    const area = Math.floor(folder / FOLDERS_PER_LEVEL);
    paths.push(
      `area-${String(area).padStart(4, "0")}/group-${group}/note-${String(index).padStart(6, "0")}.md`,
    );
  }
  return paths;
}

/** The listed tree Studio would build from `fixturePaths`, without touching disk. */
export function fixtureTree(fileCount: number): VaultTreeNode[] {
  const roots: VaultTreeNode[] = [];
  const directories = new Map<string, VaultTreeNode>();
  for (const filePath of fixturePaths(fileCount)) {
    const parts = filePath.split("/");
    let level = roots;
    for (let depth = 0; depth < parts.length; depth += 1) {
      const key = parts.slice(0, depth + 1).join("/");
      const isFile = depth === parts.length - 1;
      let node = directories.get(key);
      if (!node) {
        node = {
          name: parts[depth]!,
          path: key,
          kind: isFile ? "file" : "directory",
          ...(isFile ? {} : { children: [] }),
        };
        if (!isFile) directories.set(key, node);
        level.push(node);
      }
      if (node.children) level = node.children;
    }
  }
  return roots;
}

export function writeFixture(directory: string, fileCount: number): void {
  for (const relative of fixturePaths(fileCount)) {
    const absolute = path.join(directory, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `# ${path.basename(relative, ".md")}\n`);
  }
  spawnSync("git", ["-C", directory, "init", "--quiet"]);
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const [directory, count] = args;
  if (!directory) {
    console.error("usage: bun test/studio-vault-fixture.ts <directory> [fileCount] [--measure]");
    process.exit(1);
  }
  const fileCount = Number(count ?? 5000);
  if (!process.argv.includes("--measure")) {
    writeFixture(path.resolve(directory), fileCount);
    console.log(`wrote ${fileCount} markdown files to ${path.resolve(directory)}`);
  } else {
    const { renderVaultView } = await import("../src/cli/commands/studio/views/document");
    const started = performance.now();
    const markup = renderVaultView({
      inventory: { companions: [] },
      selection: {
        companionDigest: null,
        refresh: false,
        view: "vault",
        openPath: null,
        openDir: null,
      },
      companion: null,
      payload: null,
      error: null,
      collectedAt: null,
      writable: false,
      terminal: null,
      vault: {
        tree: fixtureTree(fileCount),
        open: null,
        refusal: null,
        incoming: null,
        overwritten: null,
        watching: true,
        warning: null,
      },
    } as never);
    const elapsed = performance.now() - started;
    const nodes = (markup.match(/<[a-z]/g) ?? []).length;
    console.log(
      JSON.stringify({
        fileCount,
        markupBytes: markup.length,
        nodes,
        renderMs: Math.round(elapsed),
      }),
    );
  }
}
