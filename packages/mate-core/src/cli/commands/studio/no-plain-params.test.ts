import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { STUDIO_PARAMS } from "./selection";

const STUDIO_ROOT = import.meta.dir;
const OWNER = path.join(STUDIO_ROOT, "selection.ts");

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The URL-shaped ways a parameter is written out, never the bare word. */
function plainUses(source: string): string[] {
  const found: string[] = [];
  for (const param of STUDIO_PARAMS) {
    const quoted = `["'\`]${escape(param)}["'\`]`;
    const forms = [
      new RegExp(`name=${quoted}`, "g"),
      new RegExp(`searchParams\\.get\\(\\s*${quoted}`, "g"),
      new RegExp(`\\.set\\(\\s*${quoted}`, "g"),
    ];
    for (const form of forms) for (const match of source.matchAll(form)) found.push(match[0]);
    const assigned = new RegExp(`(?<![\\w-])${escape(param)}=`);
    for (const literal of source.matchAll(
      /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    )) {
      if (assigned.test(literal[0])) found.push(literal[0]);
    }
  }
  return found;
}

async function studioSources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await studioSources(full)));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && full !== OWNER) {
      files.push(full);
    }
  }
  return files;
}

describe("only the selection module names a Studio URL parameter", () => {
  it("finds each plain form it guards against", () => {
    expect(plainUses('<input name="view" />')).toEqual(['name="view"']);
    expect(plainUses('url.searchParams.get("path")')).toEqual(['searchParams.get("path"']);
    expect(plainUses("params.set('companion', digest)")).toEqual([".set('companion'"]);
    expect(plainUses('fetch("/api/vault/events?companion=" + digest)')).toHaveLength(1);
    expect(plainUses("`/?view=vault&dir=${dir}`")).toHaveLength(2);
    expect(plainUses('const path = "docs"; "data-vault-dir=x"; name={DIR_PARAM}')).toEqual([]);
  });

  it("finds none outside it", async () => {
    const files = await studioSources(STUDIO_ROOT);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      expect({ file, uses: plainUses(source) }).toEqual({ file, uses: [] });
    }
  });
});
