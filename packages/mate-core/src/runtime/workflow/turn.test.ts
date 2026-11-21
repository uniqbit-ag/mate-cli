import { describe, expect, test } from "bun:test";

import { parseWorkflow, type Workflow, type WorkflowVerdict } from "./declaration";
import {
  finishTurn,
  noteShell,
  noteSkill,
  reportedSteps,
  startTurn,
  hasNotes,
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

/**
 * `finishTurn` over fixed hand-offs and `declared`'s workflow, recording each query and whether
 * the response and the workflow were read.
 */
function finish(
  turn: Turn,
  response: string,
  overrides: Partial<FinishOptions> = {},
  declared: WorkflowVerdict = { ok: true, workflow },
) {
  const queries: HandoffQuery[] = [];
  let read = false;
  let readDeclaration = false;
  const verdict = finishTurn(
    turn,
    {
      companionPath: "/acme/companion",
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
    },
    {
      readWorkflow: () => {
        readDeclaration = true;
        return declared;
      },
    },
  );
  return { verdict, queries, read: () => read, readDeclaration: () => readDeclaration };
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

  test("each report in a shell command, in either quoting", () => {
    expect(reportedSteps('git status && mate workflow done mate-apply-change "acme-fix"')).toEqual([
      { skill: "mate-apply-change", change: "acme-fix" },
    ]);
    expect(reportedSteps(`mate workflow done "acme-security-review" 'acme-fix'`)).toEqual([
      { skill: "acme-security-review", change: "acme-fix" },
    ]);
    expect(reportedSteps("mate workflow next acme-fix")).toEqual([]);
  });

  test("a report with flags, without a change, or redirected", () => {
    expect(reportedSteps("mate workflow done --json acme-lint acme-fix | jq .handoff")).toEqual([
      { skill: "acme-lint", change: "acme-fix" },
    ]);
    expect(reportedSteps("/opt/acme/bin/mate workflow done acme-lint acme-fix --json")).toEqual([
      { skill: "acme-lint", change: "acme-fix" },
    ]);
    expect(reportedSteps("mate workflow done mate-explore-change 2>&1")).toEqual([
      { skill: "mate-explore-change", change: "" },
    ]);
    expect(reportedSteps("mate workflow done mate-explore-change\nls acme")).toEqual([
      { skill: "mate-explore-change", change: "" },
    ]);
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
  test("a turn that noted nothing passes without reading the workflow", async () => {
    const turn = noteShell(startTurn("hello"), "git status");
    expect(hasNotes(turn)).toBe(false);
    expect(hasNotes(applied())).toBe(true);
    const { verdict, queries, readDeclaration } = finish(turn, "Prose.");
    expect(await verdict).toEqual({ kind: "pass" });
    expect(readDeclaration()).toBe(false);
    expect(queries).toEqual([]);
  });

  test("an invalid workflow declaration passes without fetching a hand-off", async () => {
    const { verdict, queries, read } = finish(
      applied(),
      "Prose.",
      {},
      {
        ok: false,
        file: ".mate/config/workflow.yaml",
        problems: [{ path: "stages", message: "acme" }],
      },
    );
    expect(await verdict).toEqual({ kind: "pass" });
    expect(queries).toEqual([]);
    expect(read()).toBe(false);
  });

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

  test("a section adding a later step for the change names only that", async () => {
    const { verdict } = finish(
      applied(),
      "## Next steps\n1. /mate-submit-change acme-fix\n2. /mate-publish-artifact acme-fix",
    );
    const result = await verdict;
    expect(result.kind === "sendBack" && result.reason).toContain(
      "Your `## Next steps` section lists /mate-publish-artifact acme-fix, which Mate did not print",
    );
    expect(result.kind === "sendBack" && result.reason).not.toContain("lacks");
  });

  test("an action printed without a change passes when written with the reported one", async () => {
    const submitted = noteShell(
      startTurn("/mate-submit-change acme-fix"),
      "mate workflow done mate-submit-change acme-fix",
    );
    const printed: PrintedHandoff = {
      handoff: "## Next steps\n1. Merge workset/acme-fix\n2. /mate-publish-artifact",
      actions: [{ skill: "mate-publish-artifact", change: "" }],
    };
    const response =
      "## Next steps\n1. Merge `workset/acme-fix`\n2. /mate-publish-artifact acme-fix";
    const { verdict } = finish(submitted, response, { fetchHandoff: async () => printed });
    expect(await verdict).toEqual({ kind: "pass" });
    const bare = finish(submitted, "## Next steps\n1. Merge it\n2. /mate-publish-artifact", {
      fetchHandoff: async () => printed,
    });
    expect(await bare.verdict).toEqual({ kind: "pass" });
    const lacking = finish(submitted, "## Next steps\n1. Merge `workset/acme-fix`", {
      fetchHandoff: async () => printed,
    });
    const result = await lacking.verdict;
    expect(result.kind === "sendBack" && result.reason).toContain("lacks /mate-publish-artifact.");
  });

  test("other changes' actions and skills off the path pass", async () => {
    const response = [
      "## Next steps",
      "1. /mate-propose-change acme-slice-2",
      "2. /mate-submit-change acme-fix",
      "3. /acme-unlisted acme-fix",
    ].join("\n");
    expect(await finish(applied(), response).verdict).toEqual({ kind: "pass" });
  });

  test("the action in another runtime's prefix, quoted, passes; another change does not", async () => {
    const quoted = '## Next steps\n1. `$mate-submit-change "acme-fix"`.';
    expect(await finish(applied(), quoted).verdict).toEqual({ kind: "pass" });
    const other = "## Next steps\n1. /mate-submit-change acme-fix-2";
    expect((await finish(applied(), other).verdict).kind).toBe("sendBack");
  });

  test("the actions are checked, whatever wording the printed section uses", async () => {
    const fetchHandoff = async () => ({
      handoff: "## Next steps\n1. /acme-renamed acme-fix",
      actions: [{ skill: "mate-submit-change", change: "acme-fix" }],
    });
    const { verdict } = finish(applied(), "## Next steps\n1. /mate-submit-change acme-fix", {
      fetchHandoff,
    });
    expect(await verdict).toEqual({ kind: "pass" });
  });

  test("a report for a change without a folder passes, reading nothing", async () => {
    const turn = noteShell(startTurn(""), "mate workflow done mate-apply-change gone");
    const { verdict, queries, read } = finish(turn, "Prose.");
    expect(await verdict).toEqual({ kind: "pass" });
    expect(queries).toEqual([{ change: "gone", after: "mate-apply-change" }]);
    expect(read()).toBe(false);
  });

  test("the section is held to the hand-off after the change's last report", async () => {
    const turn = noteShell(
      noteShell(startTurn(""), "mate workflow done acme-pr-check acme-fix"),
      "mate workflow done mate-submit-change acme-fix",
    );
    const fetchHandoff = async (query: HandoffQuery) =>
      query.after === "mate-submit-change"
        ? {
            handoff: "## Next steps\n1. /acme-announce acme-fix",
            actions: [{ skill: "acme-announce", change: "acme-fix" }],
          }
        : null;
    const { verdict } = finish(turn, "## Next steps\n1. /acme-announce acme-fix", {
      fetchHandoff,
    });
    expect(await verdict).toEqual({ kind: "pass" });
  });

  test("a report without a change counts as reported, with no section to hold", async () => {
    const turn = noteShell(
      startTurn("/acme-security-review acme-fix"),
      "mate workflow done mate-explore-change",
    );
    const { verdict, queries } = finish(turn, "Prose.");
    expect(await verdict).toEqual({ kind: "pass" });
    expect(queries).toEqual([]);
  });

  test("the turn's own step reported without its change is sent back once to name it", async () => {
    const turn = noteShell(
      startTurn("/acme-security-review acme-fix"),
      'mate workflow done "acme-security-review"',
    );
    const { verdict, queries } = finish(turn, "## Next steps\n1. /mate-apply-change");
    const result = await verdict;
    expect(result.kind === "sendBack" && result.reason).toStartWith(
      '`mate workflow done acme-security-review` named no change, so nothing was recorded for acme-fix. Run `mate workflow done acme-security-review "acme-fix"`',
    );
    expect(queries).toEqual([]);
    expect(await finish(turn, "Prose.", { again: true }).verdict).toEqual({ kind: "pass" });
    const named = noteShell(turn, 'mate workflow done acme-security-review "acme-fix"');
    const fixed = finish(named, "## Next steps\n1. /mate-submit-change acme-fix");
    expect(await fixed.verdict).toEqual({ kind: "pass" });
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
    expect(result.kind === "sendBack" && result.reason).toContain(
      "If it is waiting for the user, stop as you are.",
    );
    expect(read()).toBe(false);
  });

  test("a companion step passes once sent back, or without a change folder", async () => {
    const turn = noteSkill(startTurn("review"), "acme-security-review", "acme-fix");
    expect(await finish(turn, "", { again: true }).verdict).toEqual({ kind: "pass" });
    const unknown = noteSkill(startTurn("review"), "acme-security-review", "other");
    expect(await finish(unknown, "").verdict).toEqual({ kind: "pass" });
    // A skill that is no step of the path asks for nothing.
    const { verdict, queries } = finish(startTurn("/acme-unknown acme-fix"), "");
    expect(await verdict).toEqual({ kind: "pass" });
    expect(queries).toEqual([]);
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
