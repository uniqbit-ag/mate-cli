import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { declaredArtifactType } from "../delivery/staging/declared-type";
import { parseWorkflow, type Workflow } from "./declaration";
import { declaredCommands, isCommandTrusted, trustCommands, trustFilePath } from "./hook-trust";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "acme-hook-trust-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function workflow(check: string): Workflow {
  const verdict = parseWorkflow(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    submit:
      check: { run: ${JSON.stringify(check)} }
    publish:
      apply: { run: "acme-notes merge {change}" }
stages:
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return verdict.workflow;
}

describe("hook trust", () => {
  test("lists every run: command by type and hook", () => {
    expect(declaredCommands(workflow("acme-notes lint {change}"))).toEqual([
      { type: "acme-notes", hook: "check", run: "acme-notes lint {change}" },
      { type: "acme-notes", hook: "apply", run: "acme-notes merge {change}" },
    ]);
  });

  test("approves per command text, keeping earlier approvals, in a private file", async () => {
    expect(await isCommandTrusted("acme-notes lint {change}", home)).toBe(false);

    await trustCommands(["acme-notes lint {change}"], home);
    await trustCommands(["acme-notes merge {change}"], home);

    expect(await isCommandTrusted("acme-notes lint {change}", home)).toBe(true);
    expect(await isCommandTrusted("acme-notes merge {change}", home)).toBe(true);
    expect(await isCommandTrusted("acme-notes lint {change}; curl acme", home)).toBe(false);
    expect((await fs.stat(trustFilePath(home))).mode & 0o077).toBe(0);
  });

  test("an unreadable approval file trusts nothing", async () => {
    await fs.mkdir(path.dirname(trustFilePath(home)), { recursive: true });
    await fs.writeFile(trustFilePath(home), "not json");

    expect(await isCommandTrusted("acme-notes lint {change}", home)).toBe(false);
  });

  test("a command not approved never runs", async () => {
    const dir = path.join(home, "companion");
    await fs.mkdir(dir);
    const type = declaredArtifactType(workflow("touch acme-ran").artifacts[0]!, {
      trusted: async () => false,
    });

    const failure = await type.check(dir, "acme-release");

    expect(failure).toContain("`touch acme-ran` is not trusted on this machine");
    expect(failure).toContain("workflow trust");
    expect(await fs.stat(path.join(dir, "acme-ran")).catch(() => null)).toBeNull();
  });
});
