import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { companionFrameworkConfigPath } from "../../../../runtime/policy";
import { SECRET_FILE_RULE_ID, scanPublication } from "./secret-scan";

const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");
const ARCHIVE = "openspec/changes/archive/2026-07-14-my-change";

const tempRoots: string[] = [];

async function companion(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "publish-scan-"));
  tempRoots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("scanPublication", () => {
  test("reports a token in an archived design note without its value", async () => {
    const root = await companion({ [`${ARCHIVE}/design.md`]: `# D\n\ntoken ${GITHUB_TOKEN}\n` });

    const scan = await scanPublication(root, [ARCHIVE, "openspec/changes/my-change"]);

    expect(scan).toEqual({
      skipped: false,
      findings: [
        { path: `${ARCHIVE}/design.md`, line: 3, ruleId: "@secretlint/secretlint-rule-github" },
      ],
    });
    expect(JSON.stringify(scan)).not.toContain(GITHUB_TOKEN);
  });

  test("treats a staged secret file as a finding", async () => {
    const root = await companion({ [`${ARCHIVE}/.env`]: "A=1\n" });

    const scan = await scanPublication(root, [ARCHIVE]);

    expect(scan).toEqual({
      skipped: false,
      findings: [{ path: `${ARCHIVE}/.env`, line: 0, ruleId: SECRET_FILE_RULE_ID }],
    });
  });

  test("a clean archive has no findings", async () => {
    const root = await companion({ [`${ARCHIVE}/proposal.md`]: "Set GITHUB_TOKEN yourself.\n" });
    expect(await scanPublication(root, [ARCHIVE])).toEqual({ skipped: false, findings: [] });
  });

  test("an opt-out skips the scan", async () => {
    const root = await companion({ [`${ARCHIVE}/design.md`]: GITHUB_TOKEN });
    const configPath = companionFrameworkConfigPath(root);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "secrets:\n  guardrails: false\n");

    expect(await scanPublication(root, [ARCHIVE])).toEqual({ skipped: true });
  });
});
