import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const STUDIO_ROOT = path.join(import.meta.dir, "..");
const SELF = path.join(import.meta.dir, "no-raw-html.test.ts");

/** Assembled rather than written out, so this file does not match its own scan. */
const RAW_HTML_PROP = ["dangerously", "Set", "Inner", "HTML"].join("");
const RAW_HELPER = /\braw\s*\(/;
const HTML_HELPER = /from\s+"hono\/(helper\/)?html"/;

async function studioSources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await studioSources(full)));
    else if (/\.tsx?$/.test(entry.name) && full !== SELF) files.push(full);
  }
  return files;
}

describe("the renderer's escaping cannot be bypassed", () => {
  it("uses no raw-HTML escape hatch anywhere in the studio sources", async () => {
    const files = await studioSources(STUDIO_ROOT);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      expect({ file, uses: source.includes(RAW_HTML_PROP) }).toEqual({ file, uses: false });
      expect({ file, uses: RAW_HELPER.test(source) }).toEqual({ file, uses: false });
      expect({ file, uses: HTML_HELPER.test(source) }).toEqual({ file, uses: false });
    }
  });

  it("reaches hono only through the server renderer", async () => {
    for (const file of await studioSources(STUDIO_ROOT)) {
      const source = await fs.readFile(file, "utf8");
      for (const match of source.matchAll(/(?:from|import\()\s*"(hono[^"]*)"/g)) {
        expect({ file, specifier: match[1] }).toEqual({ file, specifier: "hono/jsx" });
      }
      for (const match of source.matchAll(/@jsxImportSource\s+(\S+)/g)) {
        expect({ file, pragma: match[1] }).toEqual({ file, pragma: "hono/jsx" });
      }
    }
  });
});
