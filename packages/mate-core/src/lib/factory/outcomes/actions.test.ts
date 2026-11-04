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

const workset = (stage: WorksetStageId) => ({ id: "acme-login", stage, stageLabel: `at ${stage}` });
const run = (state: OutcomeRunFacts["state"], extra: Partial<OutcomeRunFacts> = {}) => ({
  state,
  ...extra,
});
const runner = { runner: true };
const noRunner = { runner: false };
const sorted = (actions: ReadonlySet<OutcomeAction>) => [...actions].toSorted();

describe("the actions an Outcome accepts", () => {
  test.each<[string, WorksetStageId, OutcomeRunFacts | undefined, OutcomeAction[]]>([
    ["Later in Clarify intent, never run", "clarify-intent", undefined, ["later", "start"]],
    ["asking in Explore change", "explore", run("waiting"), ["answer", "later", "start"]],
    ["proposing", "propose", run("running"), ["cancel", "later", "start"]],
    ["queued for a slot", "propose", run("queued"), ["cancel", "later", "start"]],
    [
      "at the Human Reviews",
      "human-review",
      run("idle"),
      ["feedback", "later", "regenerate", "start", "start-apply"],
    ],
    ["applying", "apply", run("running"), ["cancel", "feedback", "later", "start"]],
    ["apply failed", "apply", run("failed"), ["feedback", "later", "retry", "start"]],
    ["interrupted", "apply", run("interrupted"), ["feedback", "later", "retry", "start"]],
    ["waiting for merge", "merge-wait", run("idle"), ["feedback", "later", "start"]],
    ["merged and archived", "publish", run("idle"), ["later", "publish", "start"]],
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
    ).toEqual(["answer", "later", "return", "start"]);
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

  test("an answer after the round closed reads as already answered", () => {
    expect(outcomeRefusal("answer", workset("explore"), run("running"), runner)).toBe(
      "this question was already answered",
    );
  });
});

describe("a companion the factory does not run", () => {
  test.each<WorksetStageId>([
    "clarify-intent",
    "explore",
    "propose",
    "human-review",
    "apply",
    "merge-wait",
    "publish",
  ])("accepts only Start and Later at %s", (stage) => {
    expect(sorted(outcomeActions(workset(stage), undefined, noRunner))).toEqual(["later", "start"]);
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
  });
});

test("only known names are actions", () => {
  expect(isOutcomeAction("publish")).toBe(true);
  expect(isOutcomeAction("advance")).toBe(false);
  expect(isOutcomeAction(undefined)).toBe(false);
});
