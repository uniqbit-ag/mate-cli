import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readChangeInput } from "./change-progress";
import { defaultWorkflow, parseWorkflow, type Workflow } from "./declaration";

let companion: string;

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-change-input-"));
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

describe("readChangeInput", () => {
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

    const input = await readChangeInput(
      companion,
      defaultWorkflow(),
      path.join(companion, dir),
      "acme-queue",
    );

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
    const dir = "openspec/changes/acme-queue";
    await write(`${dir}/tasks.md`, "- [x] 1.1 Acme\n");

    const input = await readChangeInput(
      companion,
      defaultWorkflow(),
      path.join(companion, dir),
      "acme-queue",
      { valid: false },
    );

    expect(input.progress.plan?.valid).toBe(false);
  });

  test("a declared type's change has no plan and lists every declared review", async () => {
    await write("notes/acme-glossary/brief.md", "# Acme\n");

    const input = await readChangeInput(
      companion,
      NOTES,
      path.join(companion, "notes/acme-glossary"),
      "acme-glossary",
    );

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
