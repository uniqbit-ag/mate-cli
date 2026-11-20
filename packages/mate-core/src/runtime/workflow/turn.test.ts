import { describe, expect, test } from "bun:test";

import { parseWorkflow, type Workflow } from "./declaration";
import {
  finishTurn,
  noteShell,
  noteSkill,
  startTurn,
  type FinishOptions,
  type HandoffQuery,
  type PrintedHandoff,
  type Turn,
} from "./turn";

const parsed = parseWorkflow(`version: 1
stages:
  - id: security-review
    steps: [{ skill: acme-security-review }]
  - id: apply
    steps: [{ skill: mate-apply-change }]
  - id: submit
    artifact: openspec
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
if (!parsed.ok) throw new Error("workflow fixture does not parse");
const workflow: Workflow = parsed.workflow;

const HANDOFF: PrintedHandoff = {
  handoff: "## Next steps\n1. /mate-submit-change acme-fix",
  actions: [{ skill: "mate-submit-change", change: "acme-fix" }],
};

/** `finishTurn` over fixed hand-offs, recording each query and whether the response was read. */
function finish(turn: Turn, response: string, overrides: Partial<FinishOptions> = {}) {
  const queries: HandoffQuery[] = [];
  let read = false;
  const verdict = finishTurn(turn, {
    workflow,
    again: false,
    runtime: "claude",
    response: async () => {
      read = true;
      return response;
    },
    fetchHandoff: async (query) => {
      queries.push(query);
      return query.change.startsWith("acme-") ? HANDOFF : null;
    },
    ...overrides,
  });
  return { verdict, queries, read: () => read };
}

const applied = () =>
  noteShell(
    startTurn("/mate-apply-change acme-fix"),
    "mate workflow done mate-apply-change acme-fix",
  );

describe("noting a turn", () => {
  test("a prompt invoking a skill starts the turn with that step", () => {
    expect(startTurn("/mate-apply-change acme-fix")).toEqual({
      step: { skill: "mate-apply-change", change: "acme-fix" },
      reports: [],
    });
    expect(startTurn("hello")).toEqual({ reports: [] });
  });

  test("a skill needs both a name and a change", () => {
    const turn = startTurn("hello");
    expect(noteSkill(turn, "acme-security-review", "acme-fix").step).toEqual({
      skill: "acme-security-review",
      change: "acme-fix",
    });
    expect(noteSkill(turn, "acme-security-review", "")).toBe(turn);
    expect(noteSkill(turn, "", "acme-fix")).toBe(turn);
    // A skill's arguments are prompt text: a flag or shell syntax is no change.
    expect(noteSkill(turn, "acme-security-review", "--after")).toBe(turn);
    expect(noteSkill(turn, "acme-security-review", "$(id)")).toBe(turn);
  });

  test("a shell command without a report leaves the same turn", () => {
    const turn = startTurn("hello");
    expect(noteShell(turn, "git status")).toBe(turn);
    expect(noteShell(turn, "mate workflow done mate-apply-change acme-fix").reports).toEqual([
      { skill: "mate-apply-change", change: "acme-fix" },
    ]);
  });
});

describe("finishTurn", () => {
  test("a missing section is sent back with the hand-off", async () => {
    const { verdict } = finish(applied(), "Done.");
    const result = await verdict;
    expect(result.kind).toBe("sendBack");
    expect(result.kind === "sendBack" && result.reason).toStartWith(
      "End your response with a final `## Next steps` section",
    );
    expect(result.kind === "sendBack" && result.reason).toContain(HANDOFF.handoff);
  });

  test("a section naming the printed actions passes", async () => {
    const { verdict } = finish(
      applied(),
      "Done.\n\n## Next steps\n1. /mate-submit-change acme-fix",
    );
    expect(await verdict).toEqual({ kind: "pass" });
  });

  test("missing and extra actions are named", async () => {
    const { verdict } = finish(applied(), "## Next steps\n1. /mate-publish-artifact acme-fix");
    const result = await verdict;
    expect(result.kind === "sendBack" && result.reason).toContain(
      "lacks /mate-submit-change acme-fix and lists /mate-publish-artifact acme-fix, which Mate did not print",
    );
  });

  test("a turn already sent back only gets a notice", async () => {
    const { verdict } = finish(applied(), "Still prose.", { again: true });
    expect(await verdict).toEqual({ kind: "notice", text: `Mate hand-off:\n\n${HANDOFF.handoff}` });
  });

  test("the hand-off is fetched after each change's last report", async () => {
    const turn = noteShell(
      applied(),
      "mate workflow done acme-security-review acme-fix && mate workflow done mate-explore-change",
    );
    const { verdict, queries } = finish(turn, "## Next steps\n1. /mate-submit-change acme-fix");
    await verdict;
    expect(queries).toEqual([{ change: "acme-fix", after: "acme-security-review" }]);
  });

  test("an unreported companion step is sent back with its report, without reading the response", async () => {
    const turn = noteSkill(startTurn("review acme-fix"), "acme-security-review", "acme-fix");
    const { verdict, read } = finish(turn, "Reviewed.");
    const result = await verdict;
    expect(result.kind === "sendBack" && result.reason).toContain(
      'run `mate workflow done acme-security-review "acme-fix"`',
    );
    expect(read()).toBe(false);
  });

  test("a companion step passes once sent back, or without a change folder", async () => {
    const turn = noteSkill(startTurn("review"), "acme-security-review", "acme-fix");
    expect(await finish(turn, "", { again: true }).verdict).toEqual({ kind: "pass" });
    const unknown = noteSkill(startTurn("review"), "acme-security-review", "other");
    expect(await finish(unknown, "").verdict).toEqual({ kind: "pass" });
  });

  test("a Mate stage skill without a report passes early, reading nothing", async () => {
    const { verdict, queries, read } = finish(startTurn("/mate-apply-change acme-fix"), "");
    expect(await verdict).toEqual({ kind: "pass" });
    expect(queries).toEqual([]);
    expect(read()).toBe(false);
  });

  test("OpenCode reasons use its skill prefix", async () => {
    const turn = noteSkill(startTurn("review"), "acme-security-review", "acme-fix");
    const result = await finish(turn, "", { runtime: "opencode" }).verdict;
    expect(result.kind === "sendBack" && result.reason).toStartWith(
      "@acme-security-review is a step of the Delivery Path",
    );
    const missing = await finish(applied(), "## Next steps\n1. nothing", { runtime: "opencode" })
      .verdict;
    expect(missing.kind === "sendBack" && missing.reason).toContain(
      "lacks @mate-submit-change acme-fix",
    );
  });
});
