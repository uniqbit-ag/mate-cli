import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  defaultWorkflow,
  loadWorkflow,
  nextStage,
  parseWorkflow,
  WORKFLOW_FILE,
  type Workflow,
  type WorkflowProblem,
} from "./declaration";

const SUBMIT = "  - id: submit\n    steps: [{ skill: mate-submit-change }]\n";
const PUBLISH = "  - id: publish\n    steps: [{ skill: mate-publish-artifact }]\n";
const TAIL = SUBMIT + PUBLISH;

const NOTES = `artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    archive: notes-history/{id}/
    reviews: { brief: brief.md, plan: plan.md }
    submit:
      check: { run: "acme-notes lint {change}" }
    publish:
      apply: { run: "acme-notes merge {change}" }
      validate: { run: "acme-notes verify {files}" }
`;

function workflowOf(source: string): Workflow {
  const verdict = parseWorkflow(source);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return verdict.workflow;
}

function problemsOf(source: string): WorkflowProblem[] {
  const verdict = parseWorkflow(source);
  if (verdict.ok) throw new Error("expected the declaration to be invalid");
  return verdict.problems;
}

/** The message of the problem at `at`. */
function problemAt(source: string, at: string): string {
  const problems = problemsOf(source);
  const found = problems.find((problem) => problem.path === at);
  if (!found) throw new Error(`no problem at ${at}: ${JSON.stringify(problems)}`);
  return found.message;
}

const stagesOf = (body: string): string => `version: 1\nstages:\n${body}`;

/** One artifact type `acme-notes` with `body` as its keys, two spaces deep per level. */
const typeOf = (body: string): string => `version: 1\nartifacts:\n  acme-notes:\n${body}`;

const APPLY = '    publish:\n      apply: { run: "acme-notes merge {change}" }\n';

describe("the default workflow", () => {
  test("is today's path, each skill stage running its Mate stage skill alone", () => {
    const { stages, file, submitArtifact } = defaultWorkflow();
    expect(file).toBeNull();
    expect(submitArtifact).toBeNull();
    expect(stages.map((stage) => [stage.id, stage.optional])).toEqual([
      ["clarify-intent", true],
      ["explore", false],
      ["propose", false],
      ["review", false],
      ["apply", false],
      ["inspect-outcome", true],
      ["refine-code", true],
      ["submit", false],
      ["publish", false],
    ]);
    expect(stages.find((stage) => stage.id === "review")).toMatchObject({ review: "schema" });
    expect(stages.find((stage) => stage.id === "apply")).toMatchObject({
      steps: [{ skill: "mate-apply-change", own: true }],
      entry: "mate-apply-change",
      source: "default",
    });
  });

  test("a file with only artifact types keeps the default stages", () => {
    const workflow = workflowOf(`version: 1\n${NOTES}`);
    expect(workflow.stages).toEqual(defaultWorkflow().stages);
    expect(workflow.artifacts.map((type) => type.name)).toEqual(["acme-notes"]);
    expect(workflow.file).toBe(WORKFLOW_FILE);
  });
});

describe("declared stages", () => {
  test("a path of custom stages only", () => {
    const workflow = workflowOf(
      stagesOf(`  - id: discover
    steps: [{ skill: acme-interview }]
  - id: draft
    steps: [{ skill: acme-draft-plan }, { skill: acme-plan-check }]
  - id: plan-review
    review: [brief, plan]
  - id: build
    optional: true
    steps: [{ skill: acme-tdd-build }]
${TAIL}`),
    );
    expect(workflow.stages.map((stage) => stage.id)).toEqual([
      "discover",
      "draft",
      "plan-review",
      "build",
      "submit",
      "publish",
    ]);
    expect(workflow.stages[0]).toMatchObject({ label: "Discover", entry: "acme-interview" });
    expect(workflow.stages[1]).toMatchObject({ entry: "acme-draft-plan" });
    expect(workflow.stages[3]).toMatchObject({ optional: true });
  });

  test("a chain around the Mate stage skill starts with its first step", () => {
    const workflow = workflowOf(
      stagesOf(`  - id: apply
    steps: [{ skill: acme-prepare }, { skill: mate-apply-change }, { skill: acme-verify }]
${TAIL}`),
    );
    expect(workflow.stages[0]).toMatchObject({
      label: "Apply change",
      entry: "acme-prepare",
      steps: [
        { skill: "acme-prepare" },
        { skill: "mate-apply-change", own: true },
        { skill: "acme-verify" },
      ],
    });
  });

  test("a replaced Mate stage skill starts its stage", () => {
    const workflow = workflowOf(
      stagesOf(`  - id: apply\n    steps: [{ skill: acme-apply }]\n${TAIL}`),
    );
    expect(workflow.stages[0]).toMatchObject({
      entry: "acme-apply",
      steps: [{ skill: "acme-apply" }],
    });
  });

  test("steps may run before and after submit's Mate skill", () => {
    const workflow = workflowOf(
      stagesOf(`  - id: submit
    steps: [{ skill: acme-pr-check }, { skill: mate-submit-change }]
${PUBLISH}`),
    );
    expect(workflow.stages[0]).toMatchObject({ entry: "acme-pr-check" });
  });

  test("next names the following required stage and the optional ones skipped", () => {
    const workflow = defaultWorkflow();
    expect(nextStage(workflow, "explore")).toEqual({
      id: "propose",
      kind: "skill",
      entry: "mate-propose-change",
      optional: [],
    });
    expect(nextStage(workflow, "propose")).toMatchObject({ id: "review", kind: "review" });
    expect(nextStage(workflow, "apply")).toEqual({
      id: "submit",
      kind: "skill",
      entry: "mate-submit-change",
      optional: [
        { id: "inspect-outcome", entry: "mate-show-me" },
        { id: "refine-code", entry: "mate-simplify-code" },
      ],
    });
    expect(nextStage(workflow, "publish")).toBeNull();
  });
});

describe("stage validation", () => {
  test("a duplicate id names the second stage", () => {
    const source = stagesOf(
      `  - id: apply\n    steps: [{ skill: acme-a }]\n  - id: apply\n    steps: [{ skill: acme-b }]\n${TAIL}`,
    );
    expect(problemAt(source, "stages[1].id")).toContain("duplicate");
  });

  test("an invalid id, label and optional are named", () => {
    const source = stagesOf(
      `  - id: Apply_Now\n    label: ""\n    optional: maybe\n    steps: [{ skill: acme-a }]\n${TAIL}`,
    );
    const paths = problemsOf(source).map((problem) => problem.path);
    expect(paths).toEqual(["stages[0].id", "stages[0].label", "stages[0].optional"]);
  });

  test("a stage needs exactly one of steps and review", () => {
    expect(problemAt(stagesOf(`  - id: plan\n${TAIL}`), "stages[0]")).toContain("needs");
    const both = stagesOf(
      `  - id: plan\n    steps: [{ skill: acme-a }]\n    review: schema\n${TAIL}`,
    );
    expect(problemAt(both, "stages[0]")).toContain("not both");
  });

  test("empty steps are refused", () => {
    expect(
      problemAt(stagesOf(`  - id: plan\n    steps: []\n${TAIL}`), "stages[0].steps"),
    ).toContain("at least one");
  });

  test("a bare skill name is not a step", () => {
    const source = stagesOf(`  - id: plan\n    steps: [acme-plan]\n${TAIL}`);
    expect(problemAt(source, "stages[0].steps[0]")).toContain("a step is a mapping");
  });

  test("a step with another key is refused", () => {
    const source = stagesOf(`  - id: plan\n    steps: [{ builtin: acme-plan }]\n${TAIL}`);
    expect(problemAt(source, "stages[0].steps[0]")).toContain("names a `skill`");
  });

  test("an invalid skill name is refused", () => {
    const source = stagesOf(`  - id: plan\n    steps: [{ skill: Acme_Plan }]\n${TAIL}`);
    expect(problemAt(source, "stages[0].steps[0].skill")).toContain("lower-case");
  });

  test("mate-archive-change is never a step", () => {
    const source = stagesOf(`  - id: plan\n    steps: [{ skill: mate-archive-change }]\n${TAIL}`);
    expect(problemAt(source, "stages[0].steps[0].skill")).toContain("never a step");
  });

  test("a skill starts one stage only", () => {
    const source = stagesOf(
      `  - id: plan\n    steps: [{ skill: acme-check }]\n  - id: build\n    steps: [{ skill: acme-check }, { skill: acme-build }]\n${TAIL}`,
    );
    expect(problemsOf(source).map((problem) => problem.path)).toEqual(["stages[1].steps[0].skill"]);
    expect(problemAt(source, "stages[1].steps[0].skill")).toContain("already starts `plan`");
  });

  test("a skill may start one stage and follow in another", () => {
    const source = stagesOf(
      `  - id: plan\n    steps: [{ skill: acme-check }]\n  - id: build\n    steps: [{ skill: acme-build }, { skill: acme-check }]\n${TAIL}`,
    );
    expect(parseWorkflow(source).ok).toBe(true);
  });

  test("a Mate stage skill in another stage names its own", () => {
    const source = stagesOf(`  - id: plan\n    steps: [{ skill: mate-propose-change }]\n${TAIL}`);
    expect(problemAt(source, "stages[0].steps[0].skill")).toContain("belongs to `propose`");
  });

  test("a Mate stage skill twice in its stage is refused", () => {
    const source = stagesOf(
      `  - id: apply\n    steps: [{ skill: mate-apply-change }, { skill: mate-apply-change }]\n${TAIL}`,
    );
    expect(problemAt(source, "stages[0].steps[1].skill")).toContain("twice");
  });

  test("publish without its Mate skill says what the chain needs", () => {
    const source = stagesOf(`${SUBMIT}  - id: publish\n    steps: [{ skill: acme-publish }]\n`);
    expect(problemAt(source, "stages[1].steps")).toContain("{ skill: mate-publish-artifact }");
  });

  test("a stage after publish is refused", () => {
    const source = stagesOf(`${TAIL}  - id: announce\n    steps: [{ skill: acme-announce }]\n`);
    expect(problemAt(source, "stages[2]")).toContain("`submit` and `publish` end the path");
  });

  test("a path without submit and publish is refused", () => {
    const source = stagesOf(`  - id: apply\n    steps: [{ skill: mate-apply-change }]\n`);
    expect(problemAt(source, "stages")).toContain("end the path");
  });

  test("submit and publish are never optional", () => {
    const source = stagesOf(
      `  - id: submit\n    optional: true\n    steps: [{ skill: mate-submit-change }]\n${PUBLISH}`,
    );
    expect(problemAt(source, "stages[0].optional")).toContain("never optional");
  });

  test("a review is schema or a list of artifact ids", () => {
    const source = stagesOf(`  - id: review\n    review: everything\n${TAIL}`);
    expect(problemAt(source, "stages[0].review")).toContain("`schema` or a list");
  });

  test("an artifact is reviewed in one review stage", () => {
    const source = stagesOf(
      `  - id: first\n    review: [specs]\n  - id: second\n    review: schema\n${TAIL}`,
    );
    expect(problemAt(source, "stages[1].review")).toContain("one review stage");
  });

  test("unknown keys fail at every level", () => {
    const paths = problemsOf(
      `version: 1\nextra: 1\nstages:\n  - id: plan\n    prompt: hi\n    steps: [{ skill: acme-a }]\n${TAIL}`,
    ).map((problem) => problem.path);
    expect(paths).toEqual(["extra", "stages[0].prompt"]);
  });

  test("a publishing key is refused like any unknown key", () => {
    const source = "version: 1\npublishing: { mode: single }\n";
    expect(problemAt(source, "publishing")).toContain("unknown key `publishing`");
  });
});

describe("strict reading", () => {
  test("invalid YAML is a problem of the file", () => {
    expect(problemsOf("version: 1\nstages: [")[0]).toMatchObject({ path: "" });
  });

  test("duplicate keys are refused", () => {
    expect(problemsOf("version: 1\nversion: 1\n")[0]!.message).toContain("unique");
  });

  test("anchors and aliases are refused with their key path", () => {
    const source = stagesOf(
      `  - id: plan\n    steps: &chain [{ skill: acme-a }]\n  - id: build\n    steps: *chain\n${TAIL}`,
    );
    expect(problemsOf(source)).toEqual([
      { path: "stages[0].steps", message: "anchors are not allowed" },
      { path: "stages[1].steps", message: "aliases are not allowed" },
    ]);
  });

  test("a missing version is refused", () => {
    expect(problemAt("stages: []\n", "version")).toContain("required");
  });

  test("a newer format asks for a newer Mate", () => {
    expect(problemsOf("version: 2\nanything: goes\n")).toEqual([
      { path: "version", message: "version 2 needs a newer Mate to read it" },
    ]);
  });

  test("a file that is no mapping is refused", () => {
    expect(problemsOf("- a\n- b\n")[0]!.message).toContain("mapping");
  });
});

describe("artifact types", () => {
  test("a custom type with every key", () => {
    const [type] = workflowOf(`version: 1\n${NOTES}`).artifacts;
    expect(type).toEqual({
      name: "acme-notes",
      change: "notes/{name}/",
      published: ["notes/index.md"],
      archive: "notes-history/{id}/",
      reviews: [
        { id: "brief", file: "brief.md" },
        { id: "plan", file: "plan.md" },
      ],
      hooks: {
        check: { run: "acme-notes lint {change}" },
        apply: { run: "acme-notes merge {change}" },
        validate: { run: "acme-notes verify {files}" },
      },
    });
  });

  test("the built-in type is never declared", () => {
    const source = `version: 1\nartifacts:\n  openspec:\n    change: specs/{name}/\n`;
    expect(problemAt(source, "artifacts.openspec")).toContain("built in");
  });

  test("change needs {name} and archive {id} as the last segment", () => {
    const source = typeOf(
      `    change: notes/\n    archive: history/{name}/\n    published: [a.md]\n${APPLY}`,
    );
    const paths = problemsOf(source).map((problem) => problem.path);
    expect(paths).toEqual(["artifacts.acme-notes.change", "artifacts.acme-notes.archive"]);
  });

  test("records under the Mate folder are refused", () => {
    const source = typeOf(
      `    change: notes/{name}/\n    archive: .mate/notes/{id}/\n    published: [a.md]\n${APPLY}`,
    );
    expect(problemAt(source, "artifacts.acme-notes.archive")).toBe("`.mate/` is Mate's");
  });

  test("an archive inside published names both keys", () => {
    const source = typeOf(
      `    change: drafts/{name}/\n    archive: notes/archive/{id}/\n    published: [notes/**]\n${APPLY}`,
    );
    expect(problemsOf(source)).toEqual([
      {
        path: "artifacts.acme-notes.published[0]",
        message: "overlaps `artifacts.acme-notes.archive`",
      },
    ]);
  });

  test("a type may not reach into the built-in type's paths", () => {
    const source = typeOf(
      `    change: notes/{name}/\n    published: [openspec/specs/acme/spec.md]\n${APPLY}`,
    );
    expect(problemAt(source, "artifacts.acme-notes.published[0]")).toContain("built-in type");
  });

  test("two types may not share a path", () => {
    const source = `version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
${APPLY}  acme-memos:
    change: notes/{name}/
    published: [memos.md]
${APPLY}`;
    expect(problemAt(source, "artifacts.acme-memos.change")).toBe(
      "overlaps `artifacts.acme-notes.change`",
    );
  });

  test("a published path leaving the companion is refused", () => {
    const source = typeOf(`    change: notes/{name}/\n    published: [../notes.md]\n${APPLY}`);
    expect(problemAt(source, "artifacts.acme-notes.published[0]")).toContain(
      "inside the companion",
    );
  });

  test("a review path leaving the change folder is refused", () => {
    const source = typeOf(
      `    change: notes/{name}/\n    published: [a.md]\n    reviews: { plan: ../plan.md }\n${APPLY}`,
    );
    expect(problemAt(source, "artifacts.acme-notes.reviews.plan")).toContain("inside");
  });

  test("publish.apply is required", () => {
    const source = typeOf(`    change: notes/{name}/\n    published: [a.md]\n    publish: {}\n`);
    expect(problemAt(source, "artifacts.acme-notes.publish.apply")).toContain("required");
  });

  test("a skill is no hook", () => {
    const source = typeOf(
      `    change: notes/{name}/\n    published: [a.md]\n    publish:\n      apply: { skill: acme-merge }\n`,
    );
    expect(problemAt(source, "artifacts.acme-notes.publish.apply")).toBe(
      "a hook is `builtin` or `run`",
    );
  });

  test("an unknown built-in hook is refused", () => {
    const source = typeOf(
      `    change: notes/{name}/\n    published: [a.md]\n    publish:\n      apply: { builtin: acme }\n`,
    );
    expect(problemAt(source, "artifacts.acme-notes.publish.apply.builtin")).toContain(
      "no built-in",
    );
  });

  test("{archive} needs a declared archive", () => {
    const source = typeOf(
      `    change: notes/{name}/\n    published: [a.md]\n    publish:\n      apply: { run: "mv {change} {archive}" }\n`,
    );
    expect(problemAt(source, "artifacts.acme-notes.publish.apply.run")).toContain("`archive`");
  });

  test("unknown keys of a type and its hook groups are refused", () => {
    const source = typeOf(
      `    change: notes/{name}/\n    published: [a.md]\n    derived: [b.md]\n    submit: { lint: 1 }\n${APPLY}`,
    );
    expect(problemsOf(source).map((problem) => problem.path)).toEqual([
      "artifacts.acme-notes.derived",
      "artifacts.acme-notes.submit.lint",
    ]);
  });
});

describe("submit names its artifact type", () => {
  const submitWith = (artifact: string): string =>
    `version: 1\n${NOTES}stages:\n  - id: submit\n    artifact: ${artifact}\n    steps: [{ skill: mate-submit-change }]\n${PUBLISH}`;

  test("a declared type", () => {
    expect(workflowOf(submitWith("acme-notes")).submitArtifact).toBe("acme-notes");
  });

  test("an unknown type is refused", () => {
    expect(problemAt(submitWith("acme-missing"), "stages[0].artifact")).toContain("unknown");
  });

  test("the built-in type's name is refused", () => {
    expect(problemAt(submitWith("openspec"), "stages[0].artifact")).toContain("built-in");
  });

  test("no other stage sets artifact", () => {
    const source = `version: 1\n${NOTES}stages:\n  - id: draft\n    artifact: acme-notes\n    steps: [{ skill: acme-draft }]\n${TAIL}`;
    expect(problemAt(source, "stages[0].artifact")).toContain("only `submit`");
  });
});

describe("loadWorkflow", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function companion(declaration?: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-workflow-"));
    dirs.push(dir);
    if (declaration !== undefined) {
      await fs.mkdir(path.join(dir, ".mate", "config"), { recursive: true });
      await fs.writeFile(path.join(dir, WORKFLOW_FILE), declaration);
    }
    return dir;
  }

  test("no file is the default", async () => {
    expect(await loadWorkflow(await companion())).toEqual({
      ok: true,
      workflow: defaultWorkflow(),
    });
  });

  test("an invalid file is never the default", async () => {
    const verdict = await loadWorkflow(await companion("version: 1\nstages: nope\n"));
    expect(verdict).toMatchObject({ ok: false, file: WORKFLOW_FILE });
  });

  test("a declared skill missing from the companion is a warning only", async () => {
    const dir = await companion(
      stagesOf(
        `  - id: apply\n    steps: [{ skill: acme-apply }, { skill: acme-verify }]\n${TAIL}`,
      ),
    );
    await fs.mkdir(path.join(dir, ".agents", "skills", "acme-verify"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".agents", "skills", "acme-verify", "SKILL.md"),
      "# verify\n",
    );
    const verdict = await loadWorkflow(dir);
    if (!verdict.ok) throw new Error("expected a valid declaration");
    expect(verdict.workflow.warnings.map((warning) => warning.split(" ")[0])).toEqual([
      "acme-apply",
    ]);
  });
});
