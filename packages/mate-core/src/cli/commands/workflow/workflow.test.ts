import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WORKFLOW_FILE } from "../../../lib/workflow/declaration";
import { isCommandTrusted } from "../../../lib/workflow/hook-trust";
import {
  runWorkflowCommand,
  type ChangeNext,
  type CommandsTrust,
  type StageSteps,
  type StepDone,
  type WorkflowFailure,
} from "./workflow";

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

const deps = (env: Record<string, string> = {}) => ({
  resolveCompanion: async () => companion,
  stdout: (line: string) => out.push(line),
  stderr: (line: string) => err.push(line),
  env,
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
    artifact: openspec
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
    expect(await steps("submit")).toMatchObject({ artifact: "openspec", next: { id: "publish" } });
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

const CHAINED = `version: 1
stages:
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-lint }, { skill: acme-verify }]
  - id: submit
    artifact: openspec
    steps: [{ skill: acme-pr-check }, { skill: mate-submit-change }, { skill: acme-announce }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`;

/** A built-in-type change with `tasks` as its checkbox marks, e.g. `"x "`. */
async function change(name: string, tasks = "", delivery?: string): Promise<string> {
  const dir = path.join(companion, "openspec", "changes", name);
  await fs.mkdir(path.join(dir, "specs"), { recursive: true });
  if (tasks) {
    const lines = [...tasks].map((mark, index) => `- [${mark}] 1.${index + 1} Task`);
    await fs.writeFile(path.join(dir, "tasks.md"), `${lines.join("\n")}\n`);
  }
  if (delivery !== undefined) await fs.writeFile(path.join(dir, "delivery.yaml"), delivery);
  return dir;
}

describe("mate workflow done", () => {
  const record = (dir: string): Promise<string> =>
    fs.readFile(path.join(companion, dir, "delivery.yaml"), "utf8");

  async function done(...args: string[]): Promise<StepDone | WorkflowFailure> {
    out = [];
    await runWorkflowCommand("done", [...args, "--json"], deps());
    expect(out).toHaveLength(1);
    return JSON.parse(out[0]!) as StepDone | WorkflowFailure;
  }

  const failure = async (...args: string[]): Promise<string> => {
    const result = (await done(...args)) as WorkflowFailure;
    expect(result.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    return result.problems[0]!.message;
  };

  test("records the step in the built-in type's change, changing nothing else", async () => {
    const head = "version: 1\nchange: acme-fix\n";
    const deliveries = "deliveries:\n  - repository: acme/app\n    branch: workset/acme-fix\n";
    await change("acme-fix", "xx", `${head}${deliveries}`);

    await runWorkflowCommand("done", ["mate-apply-change", "acme-fix"], deps());

    expect(await record("openspec/changes/acme-fix")).toBe(
      `${head}stages:\n  apply:\n    - mate-apply-change\n${deliveries}`,
    );
    // Without --json: the actions as plain data, which the skill writes into its section.
    expect(out).toEqual([
      "next: /mate-submit-change acme-fix",
      "optional: /mate-show-me acme-fix, /mate-simplify-code acme-fix.",
    ]);
    // No instruction in the output: a session treats tool output as data.
    expect(err).toEqual([]);
  });

  test("the first of several steps hands off to the next, which the developer starts", async () => {
    await declare(CHAINED);
    await change("acme-fix", "xx");

    expect(await done("mate-apply-change", "acme-fix")).toEqual({
      ok: true,
      stage: "apply",
      change: "acme-fix",
      step: "mate-apply-change",
      recorded: true,
      remaining: ["acme-lint", "acme-verify"],
      counted: {},
      complete: false,
      handoff: "## Next steps\n1. /acme-lint acme-fix",
      actions: [{ kind: "skill", skill: "acme-lint", change: "acme-fix" }],
      optional: [],
    });
  });

  test("the last step completes the stage and hands off from the change's position", async () => {
    await declare(CHAINED);
    await change("acme-fix", "xx");
    await done("mate-apply-change", "acme-fix");
    await done("acme-lint", "acme-fix");

    expect(await done("acme-verify", "acme-fix")).toMatchObject({
      recorded: true,
      remaining: [],
      counted: {},
      complete: true,
      handoff: "## Next steps\n1. /acme-pr-check acme-fix",
    });
    expect(await record("openspec/changes/acme-fix")).toContain(
      "apply:\n    - mate-apply-change\n    - acme-lint\n    - acme-verify\n",
    );
  });

  test("a step recorded twice changes nothing", async () => {
    await declare(CHAINED);
    await change("acme-fix", "xx");
    await done("mate-apply-change", "acme-fix");
    const written = await record("openspec/changes/acme-fix");

    expect(await done("mate-apply-change", "acme-fix")).toMatchObject({
      recorded: true,
      handoff: "## Next steps\n1. /acme-lint acme-fix",
    });
    expect(await record("openspec/changes/acme-fix")).toBe(written);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("a step after an unreported one is recorded, and the unreported one counts", async () => {
    await declare(CHAINED);
    await change("acme-fix", "xx");
    await done("mate-apply-change", "acme-fix");

    expect(await done("acme-verify", "acme-fix")).toMatchObject({
      recorded: true,
      remaining: [],
      counted: { apply: ["acme-lint"] },
      complete: true,
      handoff: [
        "Counted, not reported: /acme-lint acme-fix. Not an action below; run it if it did not run.",
        "",
        "## Next steps",
        "1. /acme-pr-check acme-fix",
      ].join("\n"),
    });
    expect(await record("openspec/changes/acme-fix")).toContain(
      "apply:\n    - mate-apply-change\n    - acme-verify\n",
    );
    expect(process.exitCode ?? 0).toBe(0);
    // Without --json the counted line follows the actions; none of them names acme-lint.
    out = [];
    await runWorkflowCommand("done", ["acme-verify", "acme-fix"], deps());
    expect(out).toEqual([
      "next: /acme-pr-check acme-fix",
      "Counted, not reported: /acme-lint acme-fix. Not an action below; run it if it did not run.",
    ]);
  });

  test("a Mate stage skill that did not report itself is covered by the plan", async () => {
    await declare(CHAINED);
    await change("acme-fix", "xx");

    expect(await done("acme-lint", "acme-fix")).toMatchObject({
      counted: {},
      remaining: ["acme-verify"],
      handoff: "## Next steps\n1. /acme-verify acme-fix",
    });
  });

  test("a skill that is no step and a call without a skill are refused, naming the fix", async () => {
    await declare(CHAINED);
    const dir = await change("acme-fix", "xx");

    expect(await failure("acme-unknown", "acme-fix")).toBe(
      "acme-unknown is no step of the Delivery Path; the steps are apply (mate-apply-change, acme-lint, acme-verify); submit (acme-pr-check, mate-submit-change, acme-announce); publish (mate-publish-artifact).",
    );
    expect(await failure()).toBe(
      "workflow done: a step's skill is required: mate workflow done <skill> [<change>].",
    );
    expect(await failure("apply", "acme-fix", "mate-apply-change")).toContain(
      "it takes a skill and one change name",
    );
    expect(await fs.readdir(dir)).not.toContain("delivery.yaml");
  });

  test("a change without a folder is refused where it should exist, naming the changes", async () => {
    await change("acme-fix", "xx");
    await change("acme-queue", "xx");

    expect(await failure("mate-apply-change", "acme-fx")).toBe(
      "acme-fx has no change folder at openspec/changes/acme-fx/; the changes are acme-fix, acme-queue.",
    );
    process.exitCode = 0;
    // Explore runs before any change exists: it hands off without a folder.
    expect(await done("mate-explore-change", "acme-fx")).toMatchObject({ recorded: false });
    expect(process.exitCode).not.toBe(1);
  });

  test("explore hands off without a folder when a required clarify-intent precedes it", async () => {
    await declare(`version: 1
stages:
  - id: clarify-intent
    steps: [{ skill: mate-clarify-intent }]
  - id: explore
    steps: [{ skill: mate-explore-change }]
  - id: propose
    steps: [{ skill: mate-propose-change }]
${TAIL}`);

    expect(await done("mate-explore-change", "acme-fx")).toMatchObject({
      recorded: false,
      handoff: "## Next steps\n1. /mate-propose-change acme-fx",
    });
    expect(process.exitCode).not.toBe(1);
  });

  test("apply with open tasks hands back to apply", async () => {
    await change("acme-queue", "xx  ");

    expect(await done("mate-apply-change", "acme-queue")).toMatchObject({
      complete: true,
      handoff: "## Next steps\n1. /mate-apply-change acme-queue (2 tasks open)",
    });
  });

  test("propose hands off to the reviews of the artifacts the change has", async () => {
    const dir = await change("acme-queue", "  ");
    await fs.writeFile(path.join(dir, "proposal.md"), "# Proposal\n");

    expect(((await done("mate-propose-change", "acme-queue")) as StepDone).handoff).toBe(
      [
        "## Next steps",
        "1. Review proposal: openspec/changes/acme-queue/proposal.md",
        "2. Review specs: openspec/changes/acme-queue/specs/",
        "3. Review tasks: openspec/changes/acme-queue/tasks.md",
        "4. After your review: /mate-apply-change acme-queue",
      ].join("\n"),
    );
  });

  test("submit records only the steps before mate-submit-change", async () => {
    await declare(CHAINED);
    const submitted =
      "version: 1\nchange: acme-fix\nstate: submitted\ndeliveries:\n  - repository: acme/app\n    branch: workset/acme-fix\n";
    await change("acme-fix", "xx");

    // The unreported steps of apply count once a later step is recorded.
    expect(await done("acme-pr-check", "acme-fix")).toMatchObject({
      recorded: true,
      counted: { apply: ["acme-lint", "acme-verify"] },
      handoff: [
        "Counted, not reported: /acme-lint acme-fix, /acme-verify acme-fix. Not actions below; run each if it did not run.",
        "",
        "## Next steps",
        "1. /mate-submit-change acme-fix (not submitted)",
      ].join("\n"),
    });
    await fs.writeFile(
      path.join(companion, "openspec", "changes", "acme-fix", "delivery.yaml"),
      submitted,
    );
    expect(await done("mate-submit-change", "acme-fix")).toMatchObject({
      recorded: false,
      remaining: ["acme-announce"],
      handoff: "## Next steps\n1. /acme-announce acme-fix",
    });
    expect(await done("acme-announce", "acme-fix")).toMatchObject({
      recorded: false,
      complete: true,
      handoff: "## Next steps\n1. Merge workset/acme-fix\n2. /mate-publish-artifact",
    });
    expect(await record("openspec/changes/acme-fix")).toBe(submitted);
  });

  test("submit records its steps before its Mate skill only", async () => {
    await declare(CHAINED);
    const dir = await change("acme-fix", "xx");

    expect(await done("acme-announce", "acme-fix")).toMatchObject({ recorded: false });
    expect(await fs.readdir(dir)).not.toContain("delivery.yaml");
    expect(await done("acme-pr-check", "acme-fix")).toMatchObject({ recorded: true });
    expect(await record("openspec/changes/acme-fix")).toContain("- acme-pr-check");
  });

  test("an optional stage records nothing and still hands off", async () => {
    const dir = await change("acme-fix", "xx");

    expect(await done("mate-show-me", "acme-fix")).toMatchObject({
      stage: "inspect-outcome",
      recorded: false,
      complete: true,
      handoff:
        "Optional: /mate-simplify-code acme-fix.\n\n## Next steps\n1. /mate-submit-change acme-fix",
    });
    expect(await fs.readdir(dir)).not.toContain("delivery.yaml");
  });

  test("publish records nothing, needs no folder and prints nothing", async () => {
    expect(await done("mate-publish-artifact", "acme-fix")).toEqual({
      ok: true,
      stage: "publish",
      change: "acme-fix",
      step: "mate-publish-artifact",
      recorded: false,
      remaining: [],
      counted: {},
      complete: true,
      actions: [],
      optional: [],
    });
    out = [];
    await runWorkflowCommand("done", ["mate-publish-artifact", "acme-fix"], deps());
    expect(out).toEqual([]);
    expect(await fs.readdir(companion)).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("without a change it hands off to the stage after it and writes nothing", async () => {
    expect(await done("mate-explore-change")).toEqual({
      ok: true,
      stage: "explore",
      change: null,
      step: "mate-explore-change",
      recorded: false,
      remaining: [],
      counted: {},
      complete: true,
      handoff: "## Next steps\n1. /mate-propose-change",
      actions: [{ kind: "skill", skill: "mate-propose-change" }],
      optional: [],
    });
    expect(await fs.readdir(companion)).toEqual([]);
  });

  test("records in the folder of the declared type submit handles", async () => {
    await declare(NOTES);
    await fs.mkdir(path.join(companion, "notes", "acme-glossary"), { recursive: true });

    expect(await done("acme-draft", "acme-glossary")).toMatchObject({
      stage: "draft",
      recorded: true,
      handoff: "## Next steps\n1. After your review: /mate-submit-change acme-glossary",
    });
    expect(await record("notes/acme-glossary")).toContain("stages:\n  draft:\n    - acme-draft\n");
  });

  test("in OpenCode the actions use its `@` syntax", async () => {
    await declare(NOTES);

    await runWorkflowCommand(
      "done",
      ["acme-draft", "acme-glossary"],
      deps({ OPENCODE_SESSION_ID: "ses_acme" }),
    );

    expect(out).toEqual(["next: @mate-submit-change acme-glossary"]);
  });

  test("in OpenCode the JSON section uses `@`, its actions the bare skill name", async () => {
    await change("acme-fix", "xx");
    out = [];

    await runWorkflowCommand(
      "done",
      ["mate-apply-change", "acme-fix", "--json"],
      deps({ OPENCODE_SESSION_ID: "ses_acme" }),
    );

    expect(JSON.parse(out[0]!)).toMatchObject({
      handoff: expect.stringContaining("1. @mate-submit-change acme-fix"),
      actions: [{ kind: "skill", skill: "mate-submit-change", change: "acme-fix" }],
      optional: [
        { kind: "skill", skill: "mate-show-me", change: "acme-fix" },
        { kind: "skill", skill: "mate-simplify-code", change: "acme-fix" },
      ],
    });
  });

  test("the first stage, before its change exists, hands off by name with no note", async () => {
    await declare(NOTES);

    await runWorkflowCommand("done", ["acme-draft", "acme-glossary"], deps());

    expect(err).toEqual([]);
    expect(out[0]).toStartWith("next: ");
    expect(out[0]).toEndWith(" acme-glossary");
    expect(process.exitCode).not.toBe(1);
  });

  test("an invalid declaration records nothing", async () => {
    const dir = await change("acme-fix");
    await declare("version: 2\n");

    await runWorkflowCommand("done", ["mate-apply-change", "acme-fix"], deps());

    expect(err.join("\n")).toContain("needs a newer Mate");
    expect(await fs.readdir(dir)).toEqual(["specs"]);
    expect(process.exitCode).toBe(1);
  });
});

describe("mate workflow next", () => {
  async function next(...args: string[]): Promise<ChangeNext | WorkflowFailure> {
    out = [];
    await runWorkflowCommand("next", [...args, "--json"], deps());
    expect(out).toHaveLength(1);
    return JSON.parse(out[0]!) as ChangeNext | WorkflowFailure;
  }

  test("names the stage, what is open and the next actions, writing nothing", async () => {
    const dir = await change("acme-fix", "xx  ");

    expect(await next("acme-fix")).toEqual({
      ok: true,
      change: "acme-fix",
      stage: "apply",
      open: "2 tasks open",
      handoff: "## Next steps\n1. /mate-apply-change acme-fix (2 tasks open)",
      actions: [
        { kind: "skill", skill: "mate-apply-change", change: "acme-fix", note: "2 tasks open" },
      ],
      optional: [],
    });
    expect(await fs.readdir(dir)).not.toContain("delivery.yaml");
  });

  test("a step after the Mate stage skill, with the text a developer reads", async () => {
    await declare(CHAINED);
    await change("acme-fix", "xx");

    expect(await next("acme-fix")).toMatchObject({
      stage: "apply",
      open: "acme-lint, acme-verify not recorded",
      handoff: "## Next steps\n1. /acme-lint acme-fix",
    });
    out = [];
    await runWorkflowCommand("next", ["acme-fix"], deps());
    expect(out).toEqual([
      "acme-fix is at Apply change (acme-lint, acme-verify not recorded).",
      "",
      "## Next steps",
      "1. /acme-lint acme-fix",
    ]);
  });

  test("names a counted step above the section, not as an action", async () => {
    await declare(CHAINED);
    await change(
      "acme-fix",
      "xx",
      "version: 1\nchange: acme-fix\nstages:\n  apply: [acme-verify]\n",
    );

    expect(await next("acme-fix")).toMatchObject({
      stage: "submit",
      handoff: [
        "Counted, not reported: /acme-lint acme-fix. Not an action below; run it if it did not run.",
        "",
        "## Next steps",
        "1. /acme-pr-check acme-fix",
      ].join("\n"),
    });
  });

  test("a submitted change waits for its merge, then publication", async () => {
    await change(
      "acme-fix",
      "xx",
      "version: 1\nchange: acme-fix\nstate: submitted\ndeliveries:\n  - repository: acme/app\n    branch: workset/acme-fix\n",
    );

    expect(await next("acme-fix")).toMatchObject({
      stage: "publish",
      open: null,
      handoff: "## Next steps\n1. Merge workset/acme-fix\n2. /mate-publish-artifact",
      actions: [
        { kind: "text", text: "Merge workset/acme-fix" },
        { kind: "skill", skill: "mate-publish-artifact" },
      ],
    });
  });

  test("reviews are text actions, the stage after them a skill action after the review", async () => {
    await change(
      "acme-fix",
      "  ",
      "version: 1\nchange: acme-fix\nstages:\n  propose: [mate-propose-change]\n",
    );

    expect(await next("acme-fix")).toMatchObject({
      handoff: [
        "## Next steps",
        "1. Review specs: openspec/changes/acme-fix/specs/",
        "2. Review tasks: openspec/changes/acme-fix/tasks.md",
        "3. After your review: /mate-apply-change acme-fix",
      ].join("\n"),
      actions: [
        { kind: "text", text: "Review specs: openspec/changes/acme-fix/specs/" },
        { kind: "text", text: "Review tasks: openspec/changes/acme-fix/tasks.md" },
        { kind: "skill", skill: "mate-apply-change", change: "acme-fix", afterReview: true },
      ],
    });
  });

  test("--after prints the hand-off `done` printed for that step, writing nothing", async () => {
    await declare(CHAINED);
    const submitted =
      "version: 1\nchange: acme-fix\nstate: submitted\ndeliveries:\n  - repository: acme/app\n    branch: workset/acme-fix\n";
    const dir = await change("acme-fix", "xx", submitted);

    // mate-submit-change records nothing: its chain's next step, where the change is at publish.
    expect(await next("acme-fix", "--after", "mate-submit-change")).toMatchObject({
      stage: "publish",
      handoff: "## Next steps\n1. /acme-announce acme-fix",
    });
    expect(await next("acme-fix", "--after", "acme-announce")).toMatchObject({
      handoff: "## Next steps\n1. Merge workset/acme-fix\n2. /mate-publish-artifact",
    });
    expect(await fs.readFile(path.join(dir, "delivery.yaml"), "utf8")).toBe(submitted);
    const refused = (await next("acme-fix", "--after", "acme-unknown")) as WorkflowFailure;
    expect(refused.problems[0]!.message).toContain("acme-unknown is no step of the Delivery Path");
    expect(process.exitCode).toBe(1);
  });

  test("a mistyped change exits 1 naming the changes", async () => {
    await change("acme-fix", "xx");

    const result = (await next("acme-fx")) as WorkflowFailure;

    expect(result.problems[0]!.message).toContain("the changes are acme-fix");
    expect(process.exitCode).toBe(1);
  });
});

test("an unknown subcommand prints usage and exits 1", async () => {
  await runWorkflowCommand("nope", [], deps());

  expect(err[0]).toBe("Unknown workflow command: nope");
  expect(err[1]).toContain("mate workflow done <skill>");
  expect(process.exitCode).toBe(1);
});

test("--help prints the workflow usage, also after a subcommand", async () => {
  for (const [subcommand, args] of [
    ["--help", []],
    ["help", []],
    ["done", ["-h"]],
  ] as const) {
    out = [];
    // oxlint-disable-next-line no-await-in-loop -- one call per spelling
    await runWorkflowCommand(subcommand, [...args], deps());
    expect(out.join("\n")).toContain("mate workflow done <skill> [<change>]");
    expect(out.join("\n")).toContain("mate workflow next <change>");
    expect(out.join("\n")).not.toContain("mate install");
  }
  expect(err).toEqual([]);
  expect(process.exitCode).toBeFalsy();
});

describe("mate workflow trust", () => {
  const run = `acme-notes merge {change} # ${process.pid}-${Date.now()}`;
  const declared = () => declare(NOTES.replace("acme-notes merge {change}", run));

  test("--json lists each command and approves nothing", async () => {
    await declared();

    await runWorkflowCommand("trust", ["--json"], deps());

    expect(JSON.parse(out[0]!) as CommandsTrust).toEqual({
      ok: true,
      commands: [{ type: "acme-notes", hook: "apply", run, trusted: false }],
    });
    expect(await isCommandTrusted(run)).toBe(false);
  });

  test("outside a terminal it approves nothing and exits 1", async () => {
    await declared();

    await runWorkflowCommand("trust", [], { ...deps(), confirm: async () => null });

    expect(out).toContain(`  acme-notes apply: ${run}`);
    expect(err.join("\n")).toContain("needs a terminal");
    expect(process.exitCode).toBe(1);
    expect(await isCommandTrusted(run)).toBe(false);
  });

  test("a no keeps the command untrusted; a yes approves it", async () => {
    await declared();

    await runWorkflowCommand("trust", [], { ...deps(), confirm: async () => false });
    expect(await isCommandTrusted(run)).toBe(false);

    await runWorkflowCommand("trust", [], { ...deps(), confirm: async () => true });
    expect(await isCommandTrusted(run)).toBe(true);
    expect(out.at(-1)).toBe("Approved 1 command.");

    out = [];
    await runWorkflowCommand("trust", [], { ...deps(), confirm: async () => null });
    expect(out).toEqual([`Every run: command in ${WORKFLOW_FILE} is trusted on this machine.`]);
    expect(process.exitCode).toBe(0);
  });
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
    await runWorkflowCommand("done", ["acme-apply", "acme-fix", "--json"], {
      stdout,
      stderr,
    });

    expect(JSON.parse(out[0]!)).toMatchObject({ source: "declared", entry: "acme-apply" });
    expect(JSON.parse(out[1]!)).toMatchObject({ recorded: true, complete: true });
    expect(
      await fs.readFile(
        path.join(companion, "openspec", "changes", "acme-fix", "delivery.yaml"),
        "utf8",
      ),
    ).toContain("apply:\n    - acme-apply");
  });
});
