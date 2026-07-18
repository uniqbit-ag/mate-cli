import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { frameworkConfig } from "../../../framework";
import { refreshFromTemplate, stripGuidanceBlock } from "./guidance";

const GUIDANCE_START = `<!-- ${frameworkConfig.name.toUpperCase()}:COMPANION:START -->`;
const GUIDANCE_END = `<!-- ${frameworkConfig.name.toUpperCase()}:COMPANION:END -->`;

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeTemplate(): string {
  return `${GUIDANCE_START}\nTemplate guidance content\n${GUIDANCE_END}\n`;
}

async function writeTemplate(root: string): Promise<string> {
  const templatePath = path.join(root, "template.md");
  await fs.writeFile(templatePath, makeTemplate(), "utf8");
  return templatePath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("refreshFromTemplate", () => {
  test("copies template when file does not exist", async () => {
    const root = await makeTempDir("mate-refresh-create-");
    const templatePath = await writeTemplate(root);
    const filePath = path.join(root, "CLAUDE.md");

    await refreshFromTemplate(filePath, templatePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain(GUIDANCE_START);
    expect(content).toContain("Template guidance content");
    expect(content).toContain(GUIDANCE_END);
  });

  test("replaces all MATE blocks while preserving non-MATE content", async () => {
    const root = await makeTempDir("mate-refresh-replace-");
    const templatePath = await writeTemplate(root);
    const filePath = path.join(root, "CLAUDE.md");
    // Existing file with old MATE blocks + custom content
    await fs.writeFile(
      filePath,
      `${GUIDANCE_START}\nOld guidance\n${GUIDANCE_END}\n\n<!-- MATE:GRAPHIFY:START -->\nOld graphify\n<!-- MATE:GRAPHIFY:END -->\n\n# Custom section\nCustom content here\n`,
      "utf8",
    );

    await refreshFromTemplate(filePath, templatePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("Template guidance content");
    expect(content).not.toContain("Old guidance");
    expect(content).not.toContain("Old graphify");
    expect(content).toContain("# Custom section");
    expect(content).toContain("Custom content here");
  });

  test("calling twice does not duplicate template content", async () => {
    const root = await makeTempDir("mate-refresh-idempotent-");
    const templatePath = await writeTemplate(root);
    const filePath = path.join(root, "CLAUDE.md");

    await refreshFromTemplate(filePath, templatePath);
    await refreshFromTemplate(filePath, templatePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content.match(new RegExp(GUIDANCE_START.replace(/[[\]]/g, "\\$&"), "g"))?.length).toBe(
      1,
    );
  });

  test("strips legacy standalone graphify sections during refresh", async () => {
    const root = await makeTempDir("mate-refresh-strip-legacy-graphify-");
    const templatePath = await writeTemplate(root);
    const filePath = path.join(root, "CLAUDE.md");
    await fs.writeFile(
      filePath,
      "# Custom\n\n## graphify\n\ngraphify-out/graph.json\n\n## Notes\n\nKeep me\n",
      "utf8",
    );

    await refreshFromTemplate(filePath, templatePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).not.toContain("graphify-out/graph.json");
    expect(content).toContain("## Notes");
    expect(content).toContain("Keep me");
  });
});

describe("stripGuidanceBlock", () => {
  test("removes all MATE blocks from file", async () => {
    const root = await makeTempDir("mate-strip-all-");
    const templatePath = await writeTemplate(root);
    const filePath = path.join(root, "CLAUDE.md");

    await refreshFromTemplate(filePath, templatePath);
    await stripGuidanceBlock(filePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).not.toContain(GUIDANCE_START);
    expect(content).not.toContain("Template guidance content");
  });

  test("does not throw when file does not exist", async () => {
    const root = await makeTempDir("mate-strip-missing-");
    await stripGuidanceBlock(path.join(root, "nonexistent.md"));
  });

  test("preserves content outside MATE blocks", async () => {
    const root = await makeTempDir("mate-strip-preserve-");
    const templatePath = await writeTemplate(root);
    const filePath = path.join(root, "CLAUDE.md");
    await fs.writeFile(filePath, "# Header\n", "utf8");
    await refreshFromTemplate(filePath, templatePath);

    await stripGuidanceBlock(filePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("# Header");
    expect(content).not.toContain(GUIDANCE_START);
  });

  test("strips legacy COMPANION:GUIDANCE block", async () => {
    const root = await makeTempDir("mate-strip-legacy-");
    const filePath = path.join(root, "CLAUDE.md");
    const legacyStart = "<!-- COMPANION:GUIDANCE:START -->";
    const legacyEnd = "<!-- COMPANION:GUIDANCE:END -->";
    await fs.writeFile(filePath, `${legacyStart}\nsome content\n${legacyEnd}\n# After\n`, "utf8");

    await stripGuidanceBlock(filePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).not.toContain(legacyStart);
    expect(content).toContain("# After");
  });

  test("strips current-framework legacy GUIDANCE block", async () => {
    const root = await makeTempDir("mate-strip-framework-legacy-");
    const filePath = path.join(root, "CLAUDE.md");
    const legacyStart = `<!-- ${frameworkConfig.name.toUpperCase()}:COMPANION:GUIDANCE:START -->`;
    const legacyEnd = `<!-- ${frameworkConfig.name.toUpperCase()}:COMPANION:GUIDANCE:END -->`;
    await fs.writeFile(filePath, `${legacyStart}\nsome content\n${legacyEnd}\n# After\n`, "utf8");

    await stripGuidanceBlock(filePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).not.toContain(legacyStart);
    expect(content).toContain("# After");
  });

  test("writes empty file when only MATE blocks were present", async () => {
    const root = await makeTempDir("mate-strip-only-block-");
    const templatePath = await writeTemplate(root);
    const filePath = path.join(root, "CLAUDE.md");
    await refreshFromTemplate(filePath, templatePath);

    await stripGuidanceBlock(filePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("");
  });

  test("is idempotent — stripping twice does not error", async () => {
    const root = await makeTempDir("mate-strip-idempotent-");
    const templatePath = await writeTemplate(root);
    const filePath = path.join(root, "CLAUDE.md");
    await refreshFromTemplate(filePath, templatePath);

    await stripGuidanceBlock(filePath);
    await stripGuidanceBlock(filePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("");
  });

  test("strips legacy standalone graphify sections", async () => {
    const root = await makeTempDir("mate-strip-standalone-graphify-");
    const filePath = path.join(root, "CLAUDE.md");
    await fs.writeFile(
      filePath,
      "# Header\n\n## graphify\n\ngraphify-out/graph.json\n\n## Notes\n\nKeep me\n",
      "utf8",
    );

    await stripGuidanceBlock(filePath);

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("# Header");
    expect(content).toContain("## Notes");
    expect(content).toContain("Keep me");
    expect(content).not.toContain("graphify-out/graph.json");
  });
});
