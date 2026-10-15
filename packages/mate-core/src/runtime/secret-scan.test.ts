import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { scanContent, scanFiles } from "./secret-scan";

/** Assembled at runtime so no token-shaped literal sits in the repository. */
const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanContent", () => {
  test("reports path, line and rule id without the matched value", async () => {
    const findings = await scanContent("notes/design.md", `# Design\n\ntoken: ${GITHUB_TOKEN}\n`);
    expect(findings).toEqual([
      { path: "notes/design.md", line: 3, ruleId: "@secretlint/secretlint-rule-github" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(GITHUB_TOKEN);
  });

  test("clean content yields no findings", async () => {
    expect(await scanContent("notes/design.md", "Set GITHUB_TOKEN in your shell.\n")).toEqual([]);
  });

  test("honors inline secretlint-disable comments", async () => {
    const content = `<!-- secretlint-disable -->\ntoken: ${GITHUB_TOKEN}\n<!-- secretlint-enable -->\n`;
    expect(await scanContent("notes/fake.md", content)).toEqual([]);
  });

  test("ignores a repository .secretlintrc", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, ".secretlintrc.json"), JSON.stringify({ rules: [] }));
    const findings = await scanContent(path.join(dir, "note.md"), `token: ${GITHUB_TOKEN}\n`);
    expect(findings).toHaveLength(1);
  });
});

describe("scanFiles", () => {
  test("scans each file on disk and skips missing ones", async () => {
    const dir = tempDir();
    const leaky = path.join(dir, "leaky.md");
    const clean = path.join(dir, "clean.md");
    fs.writeFileSync(leaky, `x\n${GITHUB_TOKEN}\n`);
    fs.writeFileSync(clean, "nothing here\n");
    const findings = await scanFiles([leaky, clean, path.join(dir, "missing.md")]);
    expect(findings).toEqual([
      { path: leaky, line: 2, ruleId: "@secretlint/secretlint-rule-github" },
    ]);
  });

  test("descends into directories", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "a.md"), `${GITHUB_TOKEN}\n`);
    const findings = await scanFiles([dir]);
    expect(findings.map((finding) => finding.path)).toEqual([path.join(dir, "nested", "a.md")]);
  });
});
