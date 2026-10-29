/** Helpers shared by the docs check scripts. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function isMarkdown(file: string): boolean {
  return /\.mdx?$/.test(file);
}

/** Files under `dir`, recursively, that pass `filter`. */
export function walk(dir: string, filter: (file: string) => boolean = isMarkdown): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, filter);
    return filter(path) ? [path] : [];
  });
}
