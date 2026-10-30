/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { FactoryRunView } from "../../factory-runs";
import type { StudioCompanionPayload, StudioWorkset } from "../../payload";
import { Factory } from "./index";

function card(overrides: Partial<StudioWorkset> = {}): StudioWorkset {
  return {
    id: "acme-login",
    title: "Login with SSO",
    intent: "",
    repositories: ["acme/web"],
    changes: [],
    stage: "clarify-intent",
    stageLabel: "Clarify intent",
    turn: "human",
    problems: [],
    ...overrides,
  };
}

function payload(overrides: Partial<StudioCompanionPayload> = {}): StudioCompanionPayload {
  return {
    companionPath: "/home/dev/.mate/companions/acme-companion",
    changes: [],
    specs: [],
    shipped: [],
    topology: null,
    worksets: [],
    linkedRepositories: ["acme/web"],
    worksetProblems: [],
    warnings: [],
    ...overrides,
  };
}

const render = (
  data: StudioCompanionPayload,
  writable = true,
  sessions: Record<string, string> | null = null,
  runs: Record<string, FactoryRunView> | null = null,
) =>
  String(
    <Factory
      payload={data}
      companionDigest="0123456789"
      writable={writable}
      sessions={sessions}
      runs={runs}
    />,
  );

/** The column a card was rendered in. */
function columnOf(markup: string, id: string): string | null {
  for (const match of markup.matchAll(
    /<section class="factory-column" data-column="([a-z]+)"[\s\S]*?<\/section>/g,
  )) {
    if (match[0].includes(`data-workset="${id}"`)) return match[1]!;
  }
  return null;
}

describe("Factory", () => {
  it("shows five columns in order", () => {
    const columns = [...render(payload()).matchAll(/data-column="([a-z]+)"/g)].map(
      (match) => match[1],
    );
    expect(columns).toEqual(["plan", "review", "build", "ship", "done"]);
  });

  it("places cards by their derived stage", () => {
    const markup = render(
      payload({
        worksets: [
          card({ id: "acme-explore", stage: "explore", stageLabel: "Explore change" }),
          card({
            id: "acme-review",
            stage: "human-review",
            stageLabel: "Review proposal",
            changes: ["a"],
          }),
          card({
            id: "acme-apply",
            stage: "apply",
            stageLabel: "Apply change",
            turn: "agent",
            changes: ["b"],
          }),
          card({
            id: "acme-merge",
            stage: "merge-wait",
            stageLabel: "Waiting for merge",
            changes: ["c"],
          }),
          card({
            id: "acme-done",
            stage: "done",
            stageLabel: "Done",
            turn: "none",
            changes: ["d"],
          }),
        ],
      }),
    );
    expect(columnOf(markup, "acme-explore")).toBe("plan");
    expect(columnOf(markup, "acme-review")).toBe("review");
    expect(columnOf(markup, "acme-apply")).toBe("build");
    expect(columnOf(markup, "acme-merge")).toBe("ship");
    expect(columnOf(markup, "acme-done")).toBe("done");
  });

  it("marks whose turn it is and counts the person's", () => {
    const markup = render(
      payload({
        worksets: [
          card({
            id: "acme-review",
            stage: "human-review",
            stageLabel: "Review specs, tasks",
            changes: ["a"],
          }),
          card({
            id: "acme-apply",
            stage: "apply",
            stageLabel: "Apply change",
            turn: "agent",
            changes: ["b"],
          }),
        ],
      }),
    );
    expect(markup).toContain('data-your-turn="1"');
    expect(markup).toContain("1 your turn");
    expect(markup).toMatch(
      /data-workset="acme-review"[\s\S]*?Your turn[\s\S]*?Review specs, tasks/,
    );
    expect(markup).toMatch(
      /data-workset="acme-apply"[\s\S]*?Agent&#39;s turn|data-workset="acme-apply"[\s\S]*?Agent's turn/,
    );
  });

  it("lists a card's problems on it", () => {
    const markup = render(
      payload({
        worksets: [
          card({ changes: ["acme-gone"], problems: ["acme-gone is neither active nor archived"] }),
        ],
      }),
    );
    expect(markup).toContain("acme-gone is neither active nor archived");
  });

  it("shows an empty board with a create action", () => {
    const markup = render(payload());
    expect(markup).toContain("No Worksets in this companion yet.");
    expect(markup).toContain('action="/api/factory/worksets"');
    expect(markup).toContain('<option value="acme/web">acme/web</option>');
  });

  it("offers advancing only before propose", () => {
    const markup = render(
      payload({
        worksets: [
          card({ id: "acme-a" }),
          card({ id: "acme-b", stage: "explore", stageLabel: "Explore change" }),
          card({
            id: "acme-c",
            stage: "human-review",
            stageLabel: "Review proposal",
            changes: ["x"],
          }),
        ],
      }),
    );
    expect(markup).toContain('action="/api/factory/worksets/acme-a/advance"');
    expect(markup).toContain('action="/api/factory/worksets/acme-b/advance"');
    expect(markup).not.toContain("acme-c/advance");
    expect(markup.toLowerCase()).not.toContain("approve");
  });

  it("renders no write control in read-only mode", () => {
    const markup = render(payload({ worksets: [card()] }), false);
    expect(markup).not.toContain('method="post"');
    expect(markup).toContain("Read-only mode");
  });

  it("asks for a linked repository before offering creation", () => {
    const markup = render(payload({ linkedRepositories: [] }));
    expect(markup).not.toContain('action="/api/factory/worksets"');
    expect(markup).toContain("Link a Working Repository");
  });

  it("reports unreadable records", () => {
    const markup = render(
      payload({ worksetProblems: [{ path: "worksets/acme-x.yaml", reason: "is not a mapping" }] }),
    );
    expect(markup).toContain("worksets/acme-x.yaml is not a mapping");
  });
});

describe("Workset session controls", () => {
  const board = payload({
    worksets: [
      card({ id: "acme-clarify" }),
      card({ id: "acme-explore", stage: "explore", stageLabel: "Explore change" }),
      card({
        id: "acme-review",
        stage: "human-review",
        stageLabel: "Review proposal",
        changes: ["x"],
      }),
      card({ id: "acme-ready", stage: "propose", stageLabel: "Propose change", turn: "agent" }),
    ],
  });

  it("offers Open session on the human planning stages only", () => {
    const markup = render(board, true, {});
    expect(markup).toContain('data-terminal-workset="acme-clarify"');
    expect(markup).toContain('data-terminal-workset="acme-explore"');
    expect(markup).not.toContain('data-terminal-workset="acme-review"');
    expect(markup).not.toContain('data-terminal-workset="acme-ready"');
  });

  it("offers Attach instead of a second start for a live session", () => {
    const markup = render(board, true, { "acme-explore": "acme-session-0001" });
    expect(markup).toContain('data-terminal-attach-session="acme-session-0001"');
    expect(markup).not.toContain('data-terminal-workset="acme-explore"');
  });

  it("shows no session control without factory mode or the terminal", () => {
    expect(render(board, true, null)).not.toContain("data-terminal-");
  });
});

describe("AFK run state on cards", () => {
  const review = card({
    id: "acme-review",
    stage: "human-review",
    stageLabel: "Review proposal",
    changes: ["x"],
  });
  const publish = card({
    id: "acme-publish",
    stage: "publish",
    stageLabel: "Publish",
    turn: "agent",
    changes: ["y"],
  });
  const apply = card({
    id: "acme-apply",
    stage: "apply",
    stageLabel: "Apply change",
    turn: "agent",
    changes: ["z"],
  });
  const board = payload({ worksets: [review, publish, apply] });
  const at = "2026-10-29T12:00:00.000Z";

  it("offers Start apply in the Human Reviews and Publish after the merge, and nothing that approves", () => {
    const markup = render(board, true, null, {});
    expect(markup).toContain('action="/api/factory/worksets/acme-review/start-apply"');
    expect(markup).toContain('action="/api/factory/worksets/acme-publish/publish"');
    expect(markup).not.toContain("acme-apply/start-apply");
    expect(markup.toLowerCase()).not.toContain("approve");
  });

  it("shows a running stage with its log and a cancel control", () => {
    const markup = render(board, true, null, {
      "acme-apply": { state: "running", stage: "apply", startedAt: at, updatedAt: at },
    });
    expect(markup).toMatch(/Running.*apply/);
    expect(markup).toContain('href="/api/factory/worksets/acme-apply/log"');
    expect(markup).toContain('action="/api/factory/worksets/acme-apply/cancel"');
  });

  it("puts the agent's question on the card as the person's turn, with an answer form", () => {
    const markup = render(board, true, null, {
      "acme-apply": {
        state: "waiting",
        stage: "apply",
        question: "Which login provider?",
        updatedAt: at,
      },
    });
    expect(markup).toContain("Which login provider?");
    expect(markup).toContain('action="/api/factory/worksets/acme-apply/answer"');
    expect(markup).toMatch(/data-workset="acme-apply"[^>]*data-turn="human"/);
    expect(markup).toContain('data-your-turn="2"');
  });

  it("offers retry for a failed or interrupted run, with its reason", () => {
    const markup = render(board, true, null, {
      "acme-apply": {
        state: "failed",
        stage: "apply",
        reason: "tasks are still open: z (2 open)",
        updatedAt: at,
      },
      "acme-review": { state: "interrupted", stage: "propose", updatedAt: at },
    });
    expect(markup).toContain("tasks are still open: z (2 open)");
    expect(markup).toContain("Interrupted when Studio stopped.");
    expect(markup).toContain('action="/api/factory/worksets/acme-apply/retry"');
    expect(markup).toContain('action="/api/factory/worksets/acme-review/retry"');
  });

  it("shows the pushed branch with its compare link", () => {
    const markup = render(board, true, null, {
      "acme-publish": {
        state: "idle",
        updatedAt: at,
        pushedBranch: "change/acme-publish",
        compareUrl: "https://github.com/acme/web/compare/change/acme-publish?expand=1",
      },
    });
    expect(markup).toContain(
      'href="https://github.com/acme/web/compare/change/acme-publish?expand=1"',
    );
  });

  it("offers no run control without the runner or the write path", () => {
    expect(render(board, true, null, null)).not.toContain("start-apply");
    expect(render(board, false, null, {})).not.toContain('method="post"');
  });
});
