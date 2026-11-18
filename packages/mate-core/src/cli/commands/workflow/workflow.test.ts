import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WORKFLOW_FILE } from "../../../lib/workflow/declaration";
import { runWorkflowCommand, type StageSteps, type WorkflowFailure } from "./workflow";

let companion: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "mate-workflow-command-"));
  out = [];
  err = [];
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
  process.exitCode = 0;
});

const deps = () => ({
  resolveCompanion: async () => companion,
  stdout: (line: string) => out.push(line),
  stderr: (line: string) => err.push(line),
});

async function declare(source: string): Promise<void> {
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.writeFile(path.join(companion, WORKFLOW_FILE), source);
}

async function steps(stage: string): Promise<StageSteps | WorkflowFailure> {
  await runWorkflowCommand("steps", [stage, "--json"], deps());
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]!) as StageSteps | WorkflowFailure;
}

const TAIL = `  - id: submit
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`;

const NOTES = `version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    publish:
      apply: { run: "acme-notes merge {change}" }
stages:
  - id: draft
    steps: [{ skill: acme-draft }]
  - id: plan-review
    review: schema
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`;

describe("mate workflow steps", () => {
  test("the default without a file", async () => {
    expect(await steps("explore")).toEqual({
      ok: true,
      stage: "explore",
      source: "default",
      file: null,
      steps: [{ skill: "mate-explore-change", own: true }],
      entry: "mate-explore-change",
      next: { id: "propose", kind: "skill", entry: "mate-propose-change", optional: [] },
      warnings: [],
    });
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a declared chain in order, the Mate stage skill marked as its own", async () => {
    await declare(`version: 1
stages:
  - id: propose
    steps: [{ skill: mate-propose-change }, { skill: acme-plan-check }]
  - id: review
    review: [specs, tasks]
${TAIL}`);

    expect(await steps("propose")).toMatchObject({
      source: "declared",
      file: WORKFLOW_FILE,
      steps: [{ skill: "mate-propose-change", own: true }, { skill: "acme-plan-check" }],
      entry: "mate-propose-change",
      next: { id: "review", kind: "review", review: ["specs", "tasks"] },
      // Not in this companion's skills; the Agent Runtime may still have it.
      warnings: [expect.stringContaining("acme-plan-check")],
    });
    expect(err).toEqual([expect.stringContaining("warning: acme-plan-check")]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a stage is started with its first step's skill", async () => {
    await declare(
      `version: 1\nstages:\n  - id: apply\n    steps: [{ skill: acme-prepare }, { skill: mate-apply-change }]\n${TAIL}`,
    );

    const result = (await steps("apply")) as StageSteps;

    expect(result.entry).toBe("acme-prepare");
    expect(result.steps).toEqual([
      { skill: "acme-prepare" },
      { skill: "mate-apply-change", own: true },
    ]);
  });

  test("submit reports the artifact type it handles", async () => {
    expect(await steps("submit")).toMatchObject({ artifact: null, next: { id: "publish" } });
    out = [];
    await declare(NOTES);
    expect(await steps("submit")).toMatchObject({ artifact: "acme-notes" });
  });

  test("numbered text without --json, and nothing is written", async () => {
    await runWorkflowCommand("steps", ["apply"], deps());

    expect(out).toEqual([
      "apply (default)",
      "  1. mate-apply-change (the stage's own work)",
      "  entry: mate-apply-change",
      "  next: submit (mate-submit-change)",
    ]);
    expect(await fs.readdir(companion)).toEqual([]);
  });

  test("an invalid declaration exits 1 with its problems, never the default steps", async () => {
    await declare("version: 1\nstages: [");

    const result = await steps("apply");

    expect(result).toMatchObject({ ok: false, file: WORKFLOW_FILE });
    expect((result as WorkflowFailure).problems.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("steps");
    expect(err[0]).toContain(`${WORKFLOW_FILE} is invalid`);
    expect(process.exitCode).toBe(1);
  });

  test.each([
    ["review", "review is a review stage"],
    ["acme-missing", "unknown stage acme-missing"],
  ])("%s as argument exits 1 naming the skill stages", async (stage, reason) => {
    const result = (await steps(stage)) as WorkflowFailure;

    expect(result.ok).toBe(false);
    expect(result.problems[0]!.message).toContain(reason);
    expect(result.problems[0]!.message).toContain("explore, propose, apply");
    expect(process.exitCode).toBe(1);
  });
});

describe("mate workflow done", () => {
  const record = (dir: string): Promise<string> =>
    fs.readFile(path.join(companion, dir, "delivery.yaml"), "utf8");

  test("records the stage in the built-in type's change, changing nothing else", async () => {
    const dir = path.join(companion, "openspec", "changes", "acme-fix");
    await fs.mkdir(dir, { recursive: true });
    const before =
      "version: 1\nchange: acme-fix\ndeliveries:\n  - repository: acme/app\n    branch: workset/acme-fix\n";
    await fs.writeFile(path.join(dir, "delivery.yaml"), before);

    await runWorkflowCommand("done", ["apply", "acme-fix"], deps());

    expect(await record("openspec/changes/acme-fix")).toBe(`${before}stages:\n  apply: done\n`);
    expect(out).toEqual(["acme-fix: apply done"]);
  });

  test("records in the folder of the declared type submit handles", async () => {
    await declare(NOTES);
    await fs.mkdir(path.join(companion, "notes", "acme-glossary"), { recursive: true });

    await runWorkflowCommand("done", ["draft", "acme-glossary", "--json"], deps());

    expect(await record("notes/acme-glossary")).toContain("stages:\n  draft: done\n");
    expect(JSON.parse(out[0]!)).toEqual({
      ok: true,
      stage: "draft",
      change: "acme-glossary",
      recorded: true,
    });
  });

  test("a change without its folder exits 1 naming the expected path", async () => {
    await declare(NOTES);

    await runWorkflowCommand("done", ["draft", "acme-glossary"], deps());

    expect(err).toEqual(["mate: acme-glossary has no change folder at notes/acme-glossary/"]);
    expect(process.exitCode).toBe(1);
  });

  test("submit and publish record nothing", async () => {
    const dir = path.join(companion, "openspec", "changes", "acme-fix");
    await fs.mkdir(dir, { recursive: true });

    await runWorkflowCommand("done", ["submit", "acme-fix"], deps());

    expect(await fs.readdir(dir)).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("an invalid declaration or a review stage records nothing", async () => {
    const dir = path.join(companion, "openspec", "changes", "acme-fix");
    await fs.mkdir(dir, { recursive: true });

    await runWorkflowCommand("done", ["review", "acme-fix"], deps());
    expect(process.exitCode).toBe(1);

    await declare("version: 2\n");
    await runWorkflowCommand("done", ["apply", "acme-fix"], deps());

    expect(err.join("\n")).toContain("needs a newer Mate");
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

test("an unknown subcommand prints usage and exits 1", async () => {
  await runWorkflowCommand("nope", [], deps());

  expect(err[0]).toBe("Unknown workflow command: nope");
  expect(process.exitCode).toBe(1);
});

describe("in a Launch Session", () => {
  const original = process.env.MATE_ARTIFACT_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.MATE_ARTIFACT_PATH;
    else process.env.MATE_ARTIFACT_PATH = original;
  });

  // The environment names the Session Companion, so no link is looked up and no picker opens.
  test("the stage resolves and records in the companion the environment names", async () => {
    process.env.MATE_ARTIFACT_PATH = companion;
    await declare(
      `version: 1\nstages:\n  - id: apply\n    steps: [{ skill: acme-apply }]\n${TAIL}`,
    );
    await fs.mkdir(path.join(companion, "openspec", "changes", "acme-fix"), { recursive: true });
    const { stdout, stderr } = deps();

    await runWorkflowCommand("steps", ["apply", "--json"], { stdout, stderr });
    await runWorkflowCommand("done", ["apply", "acme-fix"], { stdout, stderr });

    expect(JSON.parse(out[0]!)).toMatchObject({ source: "declared", entry: "acme-apply" });
    expect(out[1]).toBe("acme-fix: apply done");
    expect(
      await fs.readFile(
        path.join(companion, "openspec", "changes", "acme-fix", "delivery.yaml"),
        "utf8",
      ),
    ).toContain("apply: done");
  });
});
