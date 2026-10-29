import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  findCommandReferences,
  renderOpenSpecNotices,
  renderOpenSpecReferences,
  rewriteCommandReferences,
  VENDORED_WORKFLOWS,
} from "./openspec-references";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * A stand-in OpenSpec package: `bin/openspec.js` writes one SKILL.md per workflow and
 * tool, with the body each test supplies.
 */
async function fakeOpenSpec(
  body: (workflow: string, tool: string) => string,
  { frontmatter = true } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-fake-openspec-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "bin"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@fission-ai/openspec", version: "9.9.9" }),
  );
  await fs.writeFile(path.join(root, "LICENSE"), "MIT License\n\nCopyright (c) 2024 Acme\n");
  const skills: Record<string, string> = {};
  for (const { workflow } of VENDORED_WORKFLOWS) {
    for (const tool of ["claude", "agents"]) {
      const head = frontmatter ? `---\nname: ${workflow}\ndescription: x\n---\n\n` : "";
      skills[`${tool}/${workflow}`] = head + body(workflow, tool);
    }
  }
  const cli = path.join(root, "bin", "openspec.js");
  await fs.writeFile(
    cli,
    `#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] !== "init" || args[1] !== "--tools" || args[2] !== "claude,agents") process.exit(2);
const target = args[3];
const skills = ${JSON.stringify(skills)};
for (const [key, source] of Object.entries(skills)) {
  const [tool, workflow] = key.split("/");
  const dir = path.join(target, tool === "claude" ? ".claude" : ".agents", "skills", workflow);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), source);
}
`,
  );
  await fs.chmod(cli, 0o755);
  return cli;
}

describe("rewriteCommandReferences", () => {
  test("names the matching Mate skill for every mapped command", () => {
    const text = [
      "/opsx:explore /openspec-explore",
      "/opsx:propose /openspec-propose",
      "/opsx:apply /openspec-apply-change",
      "/opsx:archive /openspec-archive-change",
      "/opsx:update /openspec-update-change",
    ].join("\n");

    expect(rewriteCommandReferences(text)).toBe(
      [
        "/mate-explore-change /mate-explore-change",
        "/mate-propose-change /mate-propose-change",
        "/mate-apply-change /mate-apply-change",
        "/mate-archive-change /mate-archive-change",
        "/mate-propose-change /mate-propose-change",
      ].join("\n"),
    );
  });

  test("leaves bare CLI calls and unmapped commands alone", () => {
    const text = "Run `openspec status` then /opsx:sync and /openspec-sync-specs.";
    expect(rewriteCommandReferences(text)).toBe(text);
    expect(findCommandReferences(text)).toEqual(["/opsx:sync", "/openspec-sync-specs"]);
  });

  test("ignores path segments that look like commands", () => {
    const text = "Read [references/openspec-explore.md](references/openspec-explore.md).";
    expect(findCommandReferences(text)).toEqual([]);
    expect(rewriteCommandReferences(text)).toBe(text);
  });

  test("does not rewrite a longer command that shares a prefix", () => {
    expect(rewriteCommandReferences("`/opsx:apply-all`")).toBe("`/opsx:apply-all`");
  });
});

describe("renderOpenSpecReferences", () => {
  test("strips frontmatter, adds the header, and rewrites per tool", async () => {
    const cli = await fakeOpenSpec((workflow, tool) =>
      tool === "claude"
        ? `Body of ${workflow}. Next: \`/opsx:propose\`.\n`
        : `Next: \`/openspec-propose\`.\n`,
    );

    const files = await renderOpenSpecReferences(cli);

    expect([...files.keys()].sort()).toEqual(
      VENDORED_WORKFLOWS.flatMap(({ workflow, skill }) => [
        `agents/${skill}/references/${workflow}.md`,
        `claude/${skill}/references/${workflow}.md`,
      ]).sort(),
    );
    const explore = files.get("claude/mate-explore-change/references/openspec-explore.md");
    expect(explore).toContain("`openspec-explore`");
    expect(explore).toContain("OpenSpec 9.9.9");
    expect(explore).toContain("MIT License");
    expect(explore).not.toMatch(/^name:/m);
    expect(explore).not.toMatch(/^description:/m);
    expect(explore).toContain("Body of openspec-explore. Next: `/mate-propose-change`.");
    expect(files.get("agents/mate-apply-change/references/openspec-apply-change.md")).toContain(
      "Next: `/mate-propose-change`.",
    );
    for (const tool of ["claude", "agents"]) {
      for (const workflow of ["openspec-propose", "openspec-update-change"]) {
        expect(files.has(`${tool}/mate-propose-change/references/${workflow}.md`)).toBe(true);
      }
    }
  });

  test("fails naming an unmapped command reference", async () => {
    const cli = await fakeOpenSpec(() => "Then run `/opsx:sync`.\n");

    await expect(renderOpenSpecReferences(cli)).rejects.toThrow("/opsx:sync");
  });

  test("fails when a generated skill is missing its frontmatter", async () => {
    const cli = await fakeOpenSpec(() => "body\n", { frontmatter: false });

    await expect(renderOpenSpecReferences(cli)).rejects.toThrow("frontmatter");
  });
});

describe("renderOpenSpecNotices", () => {
  test("carries the bundled license verbatim and names the vendored files", async () => {
    const cli = await fakeOpenSpec(() => "body\n");

    const notices = await renderOpenSpecNotices(cli);

    expect(notices).toContain("MIT License\n\nCopyright (c) 2024 Acme\n");
    expect(notices).toContain("OpenSpec 9.9.9");
    for (const { skill, workflow } of VENDORED_WORKFLOWS) {
      expect(notices).toContain(`${skill}/references/${workflow}.md`);
    }
  });
});
