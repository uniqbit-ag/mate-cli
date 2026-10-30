import { describe, expect, test } from "bun:test";

import type { LinkedChange, WorksetRecord } from "./record";
import { type ChangeFacts, changeStage, deriveWorksetStage } from "./stage";

const facts = (overrides: Partial<ChangeFacts> = {}): ChangeFacts => ({
  name: "acme-form",
  archived: false,
  artifactsComplete: true,
  reviewArtifacts: ["proposal", "specs", "design", "tasks"],
  checkedTasks: 0,
  mergeSettled: false,
  published: false,
  ...overrides,
});

const record = (overrides: Partial<WorksetRecord> = {}): WorksetRecord => ({
  id: "acme-login",
  title: "Login",
  intent: "",
  repositories: ["acme/web"],
  changes: [],
  stage: "clarify-intent",
  createdAt: "",
  extra: {},
  ...overrides,
});

describe("one change's stage", () => {
  test.each([
    ["a planning artifact missing", facts({ artifactsComplete: false }), "propose"],
    ["planning complete, nothing applied", facts(), "human-review"],
    ["a task checked", facts({ checkedTasks: 1 }), "apply"],
    ["archived, not merged", facts({ archived: true }), "merge-wait"],
    [
      "archived, merged or not applicable",
      facts({ archived: true, mergeSettled: true }),
      "publish",
    ],
    ["published", facts({ archived: true, mergeSettled: true, published: true }), "done"],
  ])("%s", (_name, input, stage) => {
    expect(changeStage(input)).toBe(stage);
  });
});

describe("a Workset's stage", () => {
  const active = (name: string): LinkedChange => ({ name, kind: "active" });

  test.each([
    ["clarify-intent", "clarify-intent", "Clarify intent", "human"],
    ["explore", "explore", "Explore change", "human"],
    ["ready", "propose", "Propose change", "agent"],
  ] as const)("before propose, %s reads as %s", (recorded, stage, label, turn) => {
    expect(deriveWorksetStage(record({ stage: recorded }), [], () => undefined)).toEqual({
      stage,
      label,
      turn,
      problems: [],
    });
  });

  test("the recorded stage is ignored once a change is linked", () => {
    const derived = deriveWorksetStage(
      record({ stage: "clarify-intent", changes: ["acme-form"] }),
      [active("acme-form")],
      () => facts(),
    );
    expect(derived.stage).toBe("human-review");
    expect(derived.label).toBe("Review proposal, specs, design, tasks");
    expect(derived.turn).toBe("human");
  });

  test("a mate-minimal change names its two reviews", () => {
    const derived = deriveWorksetStage(
      record({ changes: ["acme-form"] }),
      [active("acme-form")],
      () => facts({ reviewArtifacts: ["specs", "tasks"] }),
    );
    expect(derived.label).toBe("Review specs, tasks");
  });

  test("sits at the least advanced change", () => {
    const byName: Record<string, ChangeFacts> = {
      "acme-api": facts({ name: "acme-api", checkedTasks: 3 }),
      "acme-form": facts({ name: "acme-form" }),
    };
    const derived = deriveWorksetStage(
      record({ changes: ["acme-api", "acme-form"] }),
      [active("acme-api"), active("acme-form")],
      (name) => byName[name],
    );
    expect(derived.stage).toBe("human-review");
  });

  test("waiting for merge is the person's turn, a not-applicable merge lets publish proceed", () => {
    const waiting = deriveWorksetStage(
      record({ changes: ["acme-form"] }),
      [active("acme-form")],
      () => facts({ archived: true }),
    );
    expect([waiting.stage, waiting.turn, waiting.label]).toEqual([
      "merge-wait",
      "human",
      "Waiting for merge",
    ]);
    const publish = deriveWorksetStage(
      record({ changes: ["acme-form"] }),
      [active("acme-form")],
      () => facts({ archived: true, mergeSettled: true }),
    );
    expect([publish.stage, publish.turn]).toEqual(["publish", "agent"]);
  });

  test("apply is the agent's turn and done is nobody's", () => {
    const apply = deriveWorksetStage(
      record({ changes: ["acme-form"] }),
      [active("acme-form")],
      () => facts({ checkedTasks: 1 }),
    );
    expect(apply.turn).toBe("agent");
    const done = deriveWorksetStage(record({ changes: ["acme-form"] }), [active("acme-form")], () =>
      facts({ archived: true, mergeSettled: true, published: true }),
    );
    expect(done.turn).toBe("none");
  });

  test("missing and doubly claimed changes are listed and count toward nothing", () => {
    const derived = deriveWorksetStage(
      record({ changes: ["acme-gone", "acme-shared", "acme-form"] }),
      [
        { name: "acme-gone", kind: "missing" },
        { name: "acme-shared", kind: "conflict", worksets: ["acme-login", "acme-other"] },
        active("acme-form"),
      ],
      (name) =>
        name === "acme-form" ? facts({ checkedTasks: 2 }) : facts({ artifactsComplete: false }),
    );
    expect(derived.stage).toBe("apply");
    expect(derived.problems).toEqual([
      "acme-gone is neither active nor archived",
      "acme-shared is also listed by acme-other",
    ]);
  });
});
