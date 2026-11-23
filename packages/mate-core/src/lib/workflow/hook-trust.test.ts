import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { declaredArtifactType } from "../delivery/staging/declared-type";
import { parseWorkflow, type Workflow } from "./declaration";
import {
  companionIdentity,
  declaredCommands,
  isCommandTrusted,
  trustCommands,
  trustedCommands,
  trustFilePath,
} from "./hook-trust";

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

  const scoped = (run: string, companion = "/acme/companion") =>
    ({ type: "acme-notes", hook: "check", run, companion }) as const;

  test("approves per companion, hook and command text, keeping earlier approvals, in a private file", async () => {
    expect(await isCommandTrusted(scoped("acme-notes lint {change}"), home)).toBe(false);

    await trustCommands([scoped("acme-notes lint {change}")], home);
    await trustCommands([scoped("acme-notes merge {change}")], home);

    expect(await isCommandTrusted(scoped("acme-notes lint {change}"), home)).toBe(true);
    expect(await isCommandTrusted(scoped("acme-notes merge {change}"), home)).toBe(true);
    expect(await isCommandTrusted(scoped("acme-notes lint {change}; curl acme"), home)).toBe(false);
    expect(
      await isCommandTrusted(scoped("acme-notes lint {change}", "/acme/other-companion"), home),
    ).toBe(false);
    expect(
      await isCommandTrusted({ ...scoped("acme-notes lint {change}"), hook: "apply" }, home),
    ).toBe(false);
    expect((await fs.stat(trustFilePath(home))).mode & 0o077).toBe(0);
  });

  test("concurrent approvals all survive", async () => {
    const runs = Array.from({ length: 8 }, (_, index) => `acme-notes lint ${index}`);

    await Promise.all(runs.map((run) => trustCommands([scoped(run)], home)));

    const trusted = await trustedCommands(home);
    expect(runs.every((run) => trusted(scoped(run)))).toBe(true);
    expect(
      (await fs.readdir(path.dirname(trustFilePath(home)))).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("a worktree belongs to the companion it was added from", async () => {
    const dir = path.join(home, "companion");
    const linked = path.join(home, "linked");
    await fs.mkdir(dir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git(
      "-c",
      "user.email=acme@example.com",
      "-c",
      "user.name=acme",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "acme",
    );
    git("worktree", "add", "-q", "--detach", linked);

    expect(await companionIdentity(linked)).toBe(await companionIdentity(dir));
  });

  test("an unreadable approval file trusts nothing", async () => {
    await fs.mkdir(path.dirname(trustFilePath(home)), { recursive: true });
    await fs.writeFile(trustFilePath(home), "not json");

    expect(await isCommandTrusted(scoped("acme-notes lint {change}"), home)).toBe(false);
  });

  test("a command not approved never runs", async () => {
    const dir = path.join(home, "companion");
    await fs.mkdir(dir);
    const type = declaredArtifactType(workflow("touch acme-ran").artifacts[0]!, {
      trusted: async () => false,
    });

    const failure = await type.check(dir, "acme-release");

    expect(failure).toContain("`touch acme-ran` is not trusted for this companion on this machine");
    expect(failure).toContain("workflow trust");
    expect(await fs.stat(path.join(dir, "acme-ran")).catch(() => null)).toBeNull();
  });
});
