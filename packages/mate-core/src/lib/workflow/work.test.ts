import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultWorkflow, parseWorkflow, type Workflow } from "./declaration";
import { openWork, type WorkItem } from "./work";

let companion: string;

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-work-"));
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(companion, file)), { recursive: true });
  await fs.writeFile(path.join(companion, file), content);
}

const NOTES: Workflow = (() => {
  const verdict = parseWorkflow(`version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    reviews: { brief: brief.md, plan: plan.md }
    publish:
      apply: { run: "acme-notes merge {change}" }
stages:
  - id: draft
    steps: [{ skill: acme-draft }]
  - id: plan-review
    review: schema
  - id: build
    steps: [{ skill: acme-build }]
  - id: submit
    artifact: acme-notes
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.problems));
  return verdict.workflow;
})();

async function found(workflow: Workflow, name: string): Promise<WorkItem> {
  const item = await openWork(companion, workflow).find(name);
  if ("problem" in item) throw new Error(item.problem);
  return item;
}

describe("work input", () => {
  test("reads a built-in-type change's record, tasks, present artifacts and unmerged branches", async () => {
    const dir = "openspec/changes/acme-queue";
    await write(`${dir}/tasks.md`, "- [x] 1.1 Acme\n- [ ] 1.2 Acme\n- [ ] 1.3 Acme\n");
    await write(`${dir}/proposal.md`, "# Acme\n");
    await write(
      `${dir}/delivery.yaml`,
      [
        "version: 1",
        "change: acme-queue",
        "deliveries:",
        "  - repository: acme/shop",
        "    branch: workset/acme-queue",
        "stages:",
        "  propose: [mate-propose-change]",
        "",
      ].join("\n"),
    );

    const input = await (await found(defaultWorkflow(), "acme-queue")).input();

    expect(input).toEqual({
      progress: {
        steps: { propose: ["mate-propose-change"] },
        plan: { valid: true, totalTasks: 3, completedTasks: 1 },
      },
      subject: {
        name: "acme-queue",
        artifacts: [
          { id: "proposal", path: `${dir}/proposal.md` },
          { id: "tasks", path: `${dir}/tasks.md` },
        ],
        unmerged: ["workset/acme-queue"],
      },
    });
  });

  test("takes the plan's validity from the caller", async () => {
    await write("openspec/changes/acme-queue/tasks.md", "- [x] 1.1 Acme\n");

    const input = await (await found(defaultWorkflow(), "acme-queue")).input({ valid: false });

    expect(input.progress.plan?.valid).toBe(false);
  });

  test("a declared type's change has no plan and lists every declared review", async () => {
    await write("notes/acme-glossary/brief.md", "# Acme\n");

    const input = await (await found(NOTES, "acme-glossary")).input();

    expect(input).toEqual({
      progress: { steps: {} },
      subject: {
        name: "acme-glossary",
        artifacts: [
          { id: "brief", path: "notes/acme-glossary/brief.md" },
          { id: "plan", path: "notes/acme-glossary/plan.md" },
        ],
        unmerged: [],
      },
    });
  });
});

describe("finding work", () => {
  test("a declared type's work is its change folders, recorded in place", async () => {
    await write("notes/acme-glossary/brief.md", "# Acme\n");
    await write("openspec/changes/acme-fix/tasks.md", "- [ ] 1.1 Acme\n");
    const work = openWork(companion, NOTES);

    expect(await work.names()).toEqual(["acme-glossary"]);
    await (await found(NOTES, "acme-glossary")).recordStep("draft", "acme-draft");

    const record = await fs.readFile(
      path.join(companion, "notes/acme-glossary/delivery.yaml"),
      "utf8",
    );
    expect(record).toContain("draft:");
    expect(record).toContain("acme-draft");
  });

  test("missing work names the expected path and the work that exists", async () => {
    await write("notes/acme-glossary/brief.md", "# Acme\n");

    expect(await openWork(companion, NOTES).find("acme-glosary")).toEqual({
      problem:
        "acme-glosary has no change folder at notes/acme-glosary/; the changes are acme-glossary.",
    });
    expect(await openWork(companion, defaultWorkflow()).find("acme-fix")).toEqual({
      problem: "acme-fix has no change folder at openspec/changes/acme-fix/; there are no changes.",
    });
  });

  test("an archived change is no work", async () => {
    await write("openspec/changes/archive/2026-01-02-acme-fix/tasks.md", "- [x] 1.1 Acme\n");

    expect(await openWork(companion, defaultWorkflow()).find("acme-fix")).toHaveProperty("problem");
  });
});
