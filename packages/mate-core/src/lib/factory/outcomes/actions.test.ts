import { describe, expect, test } from "bun:test";

import type { WorksetStageId } from "../../workset/stage";
import {
  isOutcomeAction,
  NO_RUNNER_REFUSAL,
  type OutcomeAction,
  outcomeActions,
  outcomeRefusal,
  type OutcomeRunFacts,
} from "./actions";

const BEFORE_PLAN = new Set<WorksetStageId>(["clarify-intent", "explore"]);
/** From Propose change on, a Workset links the change it proposed. */
const workset = (stage: WorksetStageId) => ({
  id: "acme-login",
  stage,
  stageLabel: `at ${stage}`,
  changes: BEFORE_PLAN.has(stage) ? [] : ["acme-login-plan"],
});
const run = (state: OutcomeRunFacts["state"], extra: Partial<OutcomeRunFacts> = {}) => ({
  state,
  ...extra,
});
const runner = { runner: true };
const noRunner = { runner: false };
const sorted = (actions: ReadonlySet<OutcomeAction>) => [...actions].toSorted();

describe("the actions an Outcome accepts", () => {
  test.each<[string, WorksetStageId, OutcomeRunFacts | undefined, OutcomeAction[]]>([
    [
      "Later in Clarify intent, never run",
      "clarify-intent",
      undefined,
      ["delete", "later", "start"],
    ],
    ["started, not yet run", "clarify-intent", run("idle"), ["delete", "later", "start"]],
    [
      "queued in Clarify intent",
      "clarify-intent",
      run("queued"),
      ["cancel", "delete", "later", "start"],
    ],
    ["clarifying", "clarify-intent", run("running"), ["cancel", "delete", "start"]],
    ["asking in Clarify intent", "clarify-intent", run("waiting"), ["answer", "delete", "start"]],
    // A cancelled queued run is failed; nothing runs, so it can still move to Later.
    ["clarify failed", "clarify-intent", run("failed"), ["delete", "later", "retry", "start"]],
    [
      "clarify interrupted",
      "clarify-intent",
      run("interrupted"),
      ["delete", "later", "retry", "start"],
    ],
    ["asking in Explore change", "explore", run("waiting"), ["answer", "delete", "start"]],
    ["explored", "explore", run("idle"), ["delete", "start"]],
    ["proposing", "propose", run("running"), ["cancel", "start"]],
    ["queued for a slot", "propose", run("queued"), ["cancel", "start"]],
    [
      "at the Human Reviews",
      "human-review",
      run("idle"),
      ["feedback", "regenerate", "start", "start-apply"],
    ],
    ["applying", "apply", run("running"), ["cancel", "feedback", "start"]],
    ["apply failed", "apply", run("failed"), ["feedback", "retry", "start"]],
    ["interrupted", "apply", run("interrupted"), ["feedback", "retry", "start"]],
    ["waiting for merge", "merge-wait", run("idle"), ["feedback", "start"]],
    ["merged and archived", "publish", run("idle"), ["publish", "start"]],
    ["Done", "done", run("idle", { conversation: true }), []],
  ])("%s", (_name, stage, facts, expected) => {
    expect(sorted(outcomeActions(workset(stage), facts, runner))).toEqual(expected.toSorted());
  });

  test("Take control needs the factory's conversation and no person in control", () => {
    const at = workset("apply");
    expect(
      outcomeActions(at, run("running", { conversation: true }), runner).has("take-control"),
    ).toBe(true);
    expect(outcomeActions(at, run("running"), runner).has("take-control")).toBe(false);
    const asked = run("running", {
      conversation: true,
      control: { mode: "takeover-requested" },
    });
    expect(outcomeActions(at, asked, runner).has("take-control")).toBe(false);
    expect(outcomeActions(at, asked, runner).has("return")).toBe(true);
  });

  test("Return to automation only while a person has, or asked for, control", () => {
    const at = workset("explore");
    expect(
      outcomeActions(at, run("idle", { control: { mode: "manual" } }), runner).has("return"),
    ).toBe(true);
    expect(outcomeActions(at, run("idle"), runner).has("return")).toBe(false);
  });

  test("waiting under manual control still offers Answer; the runner guards control", () => {
    expect(
      sorted(
        outcomeActions(
          workset("explore"),
          run("waiting", {
            conversation: true,
            control: { mode: "manual" },
          }),
          runner,
        ),
      ),
    ).toEqual(["answer", "return", "start"]);
  });
});

describe("a refusal", () => {
  test("names the Workset's stage, as the board's actions did", () => {
    expect(outcomeRefusal("start-apply", workset("apply"), run("idle"), runner)).toBe(
      "Workset acme-login is not in the Human Reviews; it is at at apply",
    );
    expect(outcomeRefusal("feedback", workset("publish"), run("idle"), runner)).toBe(
      "Workset acme-login takes no feedback at at publish; start a new outcome instead",
    );
    expect(outcomeRefusal("publish", workset("merge-wait"), run("idle"), runner)).toBe(
      "Workset acme-login is not merged and archived; it is at at merge-wait",
    );
  });

  test("Later once work has begun names the stage and the run", () => {
    expect(outcomeRefusal("later", workset("clarify-intent"), run("running"), runner)).toBe(
      "work on Workset acme-login has begun (at clarify-intent, running); it can no longer move to Later",
    );
    expect(outcomeRefusal("later", workset("explore"), run("idle"), runner)).toBe(
      "work on Workset acme-login has begun (at explore, idle); it can no longer move to Later",
    );
    expect(outcomeRefusal("later", workset("done"), run("idle"), runner)).toBe(
      "Workset acme-login is done",
    );
  });

  test("Delete is for an Outcome without a change, a live run or not", () => {
    for (const state of ["idle", "queued", "running", "waiting", "failed"] as const) {
      expect(outcomeRefusal("delete", workset("clarify-intent"), run(state), runner)).toBeNull();
    }
    expect(outcomeRefusal("delete", workset("apply"), run("idle"), runner)).toBe(
      "Workset acme-login has a change (acme-login-plan); only an Outcome without one can be deleted",
    );
  });

  test("Delete is refused once a person has taken over, until they return it", () => {
    for (const mode of ["manual", "takeover-requested"] as const) {
      expect(
        outcomeRefusal("delete", workset("explore"), run("idle", { control: { mode } }), runner),
      ).toBe("a person has taken over this Outcome; return it to automation first");
    }
  });

  test("an answer after the round closed reads as already answered", () => {
    expect(outcomeRefusal("answer", workset("explore"), run("running"), runner)).toBe(
      "this question was already answered",
    );
  });
});

describe("a companion the factory does not run", () => {
  test("accepts Start and Later in Clarify intent", () => {
    expect(sorted(outcomeActions(workset("clarify-intent"), undefined, noRunner))).toEqual([
      "later",
      "start",
    ]);
  });

  test.each<WorksetStageId>([
    "explore",
    "propose",
    "human-review",
    "apply",
    "merge-wait",
    "publish",
  ])("accepts only Start at %s, where work has begun", (stage) => {
    expect(sorted(outcomeActions(workset(stage), undefined, noRunner))).toEqual(["start"]);
  });

  test("accepts nothing once Done", () => {
    expect(sorted(outcomeActions(workset("done"), undefined, noRunner))).toEqual([]);
    expect(outcomeRefusal("start", workset("done"), undefined, noRunner)).toBe(
      "Workset acme-login is done",
    );
  });

  test("refuses every other action because it needs the factory mode", () => {
    expect(NO_RUNNER_REFUSAL).toBe(
      "the AFK runner needs the appliance's factory mode for this companion",
    );
    expect(outcomeRefusal("start-apply", workset("human-review"), undefined, noRunner)).toBe(
      NO_RUNNER_REFUSAL,
    );
    expect(outcomeRefusal("retry", workset("apply"), run("failed"), noRunner)).toBe(
      NO_RUNNER_REFUSAL,
    );
    expect(outcomeRefusal("delete", workset("clarify-intent"), undefined, noRunner)).toBe(
      NO_RUNNER_REFUSAL,
    );
  });
});

test("only known names are actions", () => {
  expect(isOutcomeAction("publish")).toBe(true);
  expect(isOutcomeAction("advance")).toBe(false);
  expect(isOutcomeAction(undefined)).toBe(false);
});
