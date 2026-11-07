import { describe, expect, it } from "bun:test";

import type {
  FactoryRunView,
  StudioCompanionPayload,
  StudioWorkset,
} from "@uniqbit/mate-core/studio";

import { renderMarkup } from "../../../test/render";
import { Factory, OutcomeDetail } from "./factory-view";

function outcome(overrides: Partial<StudioWorkset> = {}): StudioWorkset {
  return {
    id: "acme-onboarding",
    title: "Make onboarding easier",
    intent: "Make onboarding easier. Fewer steps, keep auth working.",
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
    ticketFormat: "none",
    worksetProblems: [],
    warnings: [],
    ...overrides,
  };
}

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

/** The board, then each Outcome's dialog, as the server-rendered board carried them all. */
async function render(
  data: StudioCompanionPayload,
  options: {
    writable?: boolean;
    sessions?: Record<string, string> | null;
    runs?: Record<string, FactoryRunView> | null;
  } = {},
): Promise<string> {
  const view = (openId?: string) => (
    <Factory
      payload={data}
      companionDigest="0123456789"
      writable={options.writable ?? true}
      sessions={options.sessions ?? null}
      runs={options.runs === undefined ? {} : options.runs}
      now={NOW}
      openId={openId}
    />
  );
  const board = await renderMarkup(view());
  // The panel portals its content, which static markup omits; each Outcome's content is
  // rendered on its own, wrapped so the helpers below find it as before.
  const dialogs = await Promise.all(
    data.worksets.map(async (workset) => {
      const detail = await renderMarkup(
        <OutcomeDetail
          payload={data}
          companionDigest="0123456789"
          writable={options.writable ?? true}
          sessions={options.sessions ?? null}
          runs={options.runs === undefined ? {} : options.runs}
          now={NOW}
          openId={workset.id}
        />,
      );
      return `<dialog id="outcome-${workset.id}">${detail}</dialog>`;
    }),
  );
  return board + dialogs.join("");
}

/** The markup of one Outcome's dialog. */
function dialogMarkup(markup: string, id: string): string {
  const start = markup.indexOf(`<dialog id="outcome-${id}"`);
  return start === -1 ? "" : markup.slice(start, markup.indexOf("</dialog>", start));
}

/** The markup of one section, from its opening tag to the next section or the dialogs. */
function sectionMarkup(markup: string, id: string): string {
  const start = markup.indexOf(`data-section="${id}"`);
  if (start === -1) return "";
  const ends = [markup.indexOf("data-section=", start + 1), markup.indexOf("<dialog", start)];
  const end = Math.min(...ends.filter((index) => index !== -1));
  return markup.slice(start, Number.isFinite(end) ? end : undefined);
}

const started = (queuedAt = "2026-11-02T09:00:00.000Z") => ({ queuedAt });

const waiting: FactoryRunView = {
  state: "waiting",
  stage: "clarify",
  questions: [
    {
      question: "Launch languages?",
      options: ["English only", "English + German"],
      recommended: "English only",
    },
  ],
  round: "acme-round",
  updatedAt: "2026-11-02T10:00:00.000Z",
};
const running = (stage: "explore" | "apply" = "apply"): FactoryRunView => ({
  state: "running",
  stage,
  startedAt: "2026-11-02T11:00:00.000Z",
  updatedAt: "2026-11-02T11:00:00.000Z",
});

describe("the Factory home", () => {
  it("opens with the outcome input and says when the factory is idle", async () => {
    const markup = await render(payload());
    expect(markup).toContain("What should we build or improve?");
    expect(markup).toMatch(/value="start"[^>]*name="start"/);
    expect(markup).toMatch(/value="later"[^>]*name="start"/);
    expect(await render(payload({ worksets: [outcome()] }))).toContain("The factory is idle.");
    expect(markup).not.toContain('data-section="attention"');
    expect(markup).not.toContain('name="repository"');
  });

  it("offers a repository choice only when several are linked", async () => {
    expect(await render(payload({ linkedRepositories: ["acme/web", "acme/api"] }))).toContain(
      'name="repository"',
    );
  });

  it("offers a Ticket field only when tickets are on", async () => {
    expect(await render(payload())).not.toContain('name="ticket"');
    const markup = await render(payload({ ticketFormat: "jira" }));
    const input = markup.slice(markup.indexOf("data-outcome-input"));
    const field = input.slice(0, input.indexOf("</form>")).match(/<input[^>]*>/)?.[0] ?? "";
    expect(field).toContain('name="ticket"');
    expect(field).toContain('placeholder="ABC-123"');
    expect(field).not.toContain("required");
    expect(markup).toMatch(/data-factory-action="\/create"[^]*name="ticket"/);
  });

  it("offers the Ticket field when starting a new outcome after publish", async () => {
    const done = outcome({ stage: "done", stageLabel: "Done", turn: "none", ...started() });
    const off = dialogMarkup(await render(payload({ worksets: [done] })), "acme-onboarding");
    expect(off).toContain("Start as a new outcome");
    expect(off).not.toContain('name="ticket"');
    const on = dialogMarkup(
      await render(payload({ worksets: [done], ticketFormat: "jira" })),
      "acme-onboarding",
    );
    expect(on).toMatch(/class="outcome-feedback"[^]*name="ticket"[^]*Start as a new outcome/);
  });

  it("lists a running Outcome as one row with where it is, opening its dialog", async () => {
    const markup = await render(
      payload({
        worksets: [outcome({ stage: "apply", stageLabel: "Apply change", ...started() })],
      }),
      {
        runs: {
          "acme-onboarding": {
            ...running(),
            situations: [
              {
                text: "Two of five tasks done.",
                at: "2026-11-02T11:30:00.000Z",
              },
            ],
          },
        },
      },
    );
    const active = sectionMarkup(markup, "active");
    expect(active).toContain("Make onboarding easier");
    expect(active).toContain("Two of five tasks done.");
    expect(active).toContain("4/7");
    expect(active).toContain("30m");
    // The row is a button that opens the Outcome's dialog through the address.
    expect(active).toMatch(/<button type="button" class="outcome-row" data-outcome-row=""/);
    expect(active).not.toContain("<form");
    expect(active).not.toContain("Apply change");
  });

  it("puts goal, situation, next step, results and the execution facts in the dialog", async () => {
    const markup = await render(
      payload({
        worksets: [
          outcome({
            stage: "merge-wait",
            stageLabel: "Waiting for merge",
            changes: ["acme-signup"],
            ...started(),
          }),
        ],
      }),
      {
        runs: {
          "acme-onboarding": {
            state: "idle",
            updatedAt: "",
            reviewReports: { "acme-signup": "r1" },
            compareUrl: "https://github.com/acme/web/compare/change/acme-onboarding?expand=1",
            situations: [
              {
                text: "The three-step signup is built on the delivery branch.",
                at: "2026-11-02T11:00:00.000Z",
                checks: [{ name: "unit tests", passed: true }],
              },
            ],
          },
        },
      },
    );
    // Close, its first focus and Previous/Next belong to the panel (panel.test.tsx).
    const dialog = dialogMarkup(markup, "acme-onboarding");
    expect(dialog).toContain("Ready to merge");
    expect(dialog).toContain("The three-step signup is built on the delivery branch.");
    expect(dialog).toContain("Ready for you to merge");
    expect(dialog).toContain("Review plan");
    expect(dialog).toContain("View changes");
    expect(dialog).toContain('data-passed="true"');
    // The rail holds the execution facts and no Delivery Path map.
    const rail = dialog.slice(dialog.indexOf('class="outcome-dialog-rail"'));
    expect(dialog).not.toContain("data-map-stage");
    expect(rail).toContain("Waiting for merge");
    expect(dialog.slice(0, dialog.indexOf('class="outcome-dialog-rail"'))).not.toContain(
      "Waiting for merge",
    );
  });

  it("lists an Outcome that needs the person once, under Needs you", async () => {
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      runs: { "acme-onboarding": waiting },
    });
    expect(sectionMarkup(markup, "attention")).toContain("Decision needed");
    expect(markup).not.toContain('data-section="active"');
    expect(markup).not.toContain("The factory is idle.");
  });

  it("asks a decision in the dialog with one-click options and the recommendation", async () => {
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      runs: { "acme-onboarding": waiting },
    });
    const dialog = dialogMarkup(markup, "acme-onboarding");
    expect(dialog).toContain("Launch languages?");
    expect(dialog).toMatch(/data-recommended="true"[^>]*>.*?English only.*?recommended/s);
    expect(dialog).toMatch(/data-option-key="1" aria-keyshortcuts="1"/);
    expect(dialog).toContain("English + German");
    expect(dialog).toContain('name="answer"');
    // Every answer form, one-click option or typed, names the round it answers.
    expect(dialog.match(/name="round" value="acme-round"/g)).toHaveLength(3);
    expect(markup).toContain('data-needs-you="1"');
  });

  it("asks grouped questions as choices in one form, choosing nothing for the person", async () => {
    const grouped: FactoryRunView = {
      ...waiting,
      questions: [
        ...(waiting.state === "waiting" ? waiting.questions : []),
        { question: "Keep the old signup page?" },
      ],
    } as FactoryRunView;
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      runs: { "acme-onboarding": grouped },
    });
    expect(sectionMarkup(markup, "attention")).toContain("Decisions needed (2)");
    const dialog = dialogMarkup(markup, "acme-onboarding");
    const sheet = dialog.slice(0, dialog.indexOf('class="outcome-dialog-status"'));
    expect(sheet).toMatch(/type="radio" name="choice-0" value="English only"/);
    expect(sheet).not.toContain("<select");
    expect(sheet).not.toContain("checked");
    expect(sheet).toContain('name="answer-1"');
    // Nothing is sent before every question has an answer.
    expect(sheet).toMatch(/class="factory-primary" disabled="">Send answers/);
    expect(sheet).toContain("0 of 2 answered");
    // No number keys in a grouped round.
    expect(sheet).not.toContain("data-option-key");
    // A round without a recommendation for every question offers no accept-all.
    expect(sheet).not.toContain("Accept all recommendations");
    expect(sheet.match(/data-factory-action=/g)).toHaveLength(1);
    expect(sheet).toContain('name="round" value="acme-round"');
  });

  it("accepts every recommendation of a round only as its own action", async () => {
    const grouped = {
      ...waiting,
      questions: [
        {
          question: "Launch languages?",
          options: ["English only", "Both"],
          recommended: "English only",
        },
        {
          question: "Keep the old page?",
          options: ["Yes", "No"],
          recommended: "No",
        },
      ],
    } as FactoryRunView;
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      runs: { "acme-onboarding": grouped },
    });
    const dialog = dialogMarkup(markup, "acme-onboarding");
    const accept = dialog.slice(
      dialog.lastIndexOf("<form", dialog.indexOf("Accept all recommendations")),
    );
    expect(accept).toContain('name="choice-0" value="English only"');
    expect(accept).toContain('name="choice-1" value="No"');
    expect(accept).toContain('name="round" value="acme-round"');
  });

  it("shows a plan review with a control per report, Approve, Request a change and Regenerate", async () => {
    const markup = await render(
      payload({
        worksets: [
          outcome({
            stage: "human-review",
            changes: ["acme-a", "acme-b"],
            ...started(),
          }),
        ],
      }),
      {
        runs: {
          "acme-onboarding": {
            state: "idle",
            updatedAt: "",
            reviewReports: { "acme-a": "r1" },
          },
        },
      },
    );
    expect(sectionMarkup(markup, "attention")).toContain("Plan ready for review");
    const dialog = dialogMarkup(markup, "acme-onboarding");
    const review = dialog.slice(dialog.indexOf('aria-label="Needs you"'));
    expect(review).toMatch(/data-open-report="acme-a"[^>]*>Read the report · acme-a</);
    expect(dialog).toContain("start-apply");
    expect(dialog).toContain('name="feedback"');
    expect(dialog).toContain('data-report-missing="acme-b"');
    expect(dialog).toContain("Regenerate");
    // Reports open in the panel on request; none is embedded and no link leaves Studio.
    expect(dialog).not.toContain("<iframe");
    expect(dialog).not.toContain("/studio/reports/r1");
  });

  it("offers Approve only at the Human Reviews", async () => {
    const markup = await render(
      payload({
        worksets: [
          outcome({
            stage: "apply",
            stageLabel: "Apply change",
            changes: ["acme-a"],
            ...started(),
          }),
        ],
      }),
      { runs: { "acme-onboarding": { state: "idle", updatedAt: "" } } },
    );
    const dialog = dialogMarkup(markup, "acme-onboarding");
    expect(dialog).not.toContain("start-apply");
    expect(dialog).not.toContain("Regenerate");
    expect(dialog).toContain('name="feedback"');
  });

  it("offers no Request a change at Publish, only Publish and a new outcome", async () => {
    const markup = await render(
      payload({
        worksets: [
          outcome({
            stage: "publish",
            stageLabel: "Publish",
            changes: ["acme-a"],
            ...started(),
          }),
        ],
      }),
      { runs: { "acme-onboarding": { state: "idle", updatedAt: "" } } },
    );
    const dialog = dialogMarkup(markup, "acme-onboarding");
    expect(dialog).not.toContain('name="feedback"');
    expect(dialog).toContain("/acme-onboarding/publish");
    expect(dialog).toContain("Start as a new outcome");
  });

  it("lists Later Outcomes with Start and sets no stage by hand", async () => {
    const markup = await render(
      payload({
        worksets: [
          outcome({ id: "acme-saved" }),
          outcome({
            id: "acme-later",
            stage: "explore",
            stageLabel: "Explore change",
          }),
          outcome({ id: "acme-started", stage: "explore", ...started() }),
        ],
      }),
      { sessions: {} },
    );
    expect(sectionMarkup(markup, "later")).toContain("/acme-saved/start");
    const saved = dialogMarkup(markup, "acme-saved");
    expect(saved).toContain("/acme-saved/start");
    for (const id of ["acme-saved", "acme-later", "acme-started"]) {
      const dialog = dialogMarkup(markup, id);
      expect(dialog).not.toContain("/advance");
      expect(dialog).not.toContain("Intent clarified");
      expect(dialog).not.toContain("Ready for propose");
      expect(dialog).not.toContain("Open session");
      expect(dialog).not.toContain("data-terminal-workset");
      expect(dialog).not.toContain("data-terminal-attach-session");
    }
    expect(dialogMarkup(markup, "acme-started")).not.toContain("/acme-started/start");
  });

  it("shows a queued Outcome as waiting for a slot", async () => {
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      runs: {
        "acme-onboarding": { state: "queued", stage: "clarify", updatedAt: "" },
      },
    });
    expect(sectionMarkup(markup, "active")).toContain("Waiting for a free slot.");
  });

  it("offers a new outcome instead of feedback once delivered", async () => {
    const markup = await render(
      payload({ worksets: [outcome({ stage: "done", changes: ["acme-x"] })] }),
    );
    expect(sectionMarkup(markup, "completed")).toContain("Make onboarding easier");
    expect(dialogMarkup(markup, "acme-onboarding")).toContain("Start as a new outcome");
    expect(markup).not.toContain('name="feedback"');
  });

  it("is read-only without the write path", async () => {
    const markup = await render(
      payload({
        worksets: [outcome({ stage: "human-review", changes: ["acme-x"], ...started() })],
      }),
      { writable: false, runs: { "acme-onboarding": waiting } },
    );
    expect(markup).toContain("Read-only mode");
    expect(markup).not.toContain('<form method="post"');
  });

  it("keeps the run state in the rail and the run's actions in view", async () => {
    const markup = await render(
      payload({
        worksets: [
          outcome({
            stage: "explore",
            stageLabel: "Explore change",
            ...started(),
          }),
        ],
      }),
      { runs: { "acme-onboarding": running("explore") } },
    );
    const dialog = dialogMarkup(markup, "acme-onboarding");
    const rail = dialog.slice(dialog.indexOf('class="outcome-dialog-rail"'));
    expect(rail).toContain("running explore");
    expect(dialog).toMatch(/aria-label="Run actions">.*?Cancel run/s);
    expect(sectionMarkup(markup, "active")).not.toContain("running explore");
  });
});

describe("controls with and without the runner", () => {
  /** Every action the board and the Outcome's dialog offer for it. */
  const offered = (markup: string) =>
    [
      ...new Set(
        [...markup.matchAll(/data-factory-action="\/acme-onboarding\/([a-z-]+)"/g)].map(
          (match) => match[1],
        ),
      ),
    ].toSorted();

  it.each<[string, Partial<StudioWorkset>, FactoryRunView | undefined, string[], string[]]>([
    ["Later in Clarify intent", { stage: "clarify-intent" }, undefined, ["start"], ["start"]],
    [
      "queued in Clarify intent",
      { stage: "clarify-intent", ...started() },
      { state: "queued", stage: "clarify", updatedAt: "" } as FactoryRunView,
      ["cancel", "later"],
      ["later"],
    ],
    [
      "asking in Clarify intent",
      { stage: "clarify-intent", ...started() },
      waiting,
      ["answer"],
      ["later"],
    ],
    [
      "at the Human Reviews",
      { stage: "human-review", stageLabel: "Human Reviews", ...started() },
      undefined,
      ["feedback", "regenerate", "start-apply"],
      [],
    ],
    [
      "applying",
      { stage: "apply", stageLabel: "Apply change", ...started() },
      running(),
      ["cancel", "feedback"],
      [],
    ],
    [
      "merged and archived",
      { stage: "publish", stageLabel: "Publish", ...started() },
      undefined,
      ["publish"],
      [],
    ],
    ["Done", { stage: "done", stageLabel: "Done", ...started() }, undefined, [], []],
  ])("%s", async (_name, overrides, run, withRunner, withoutRunner) => {
    const data = payload({ worksets: [outcome(overrides)] });
    const runs: Record<string, FactoryRunView> = run ? { "acme-onboarding": run } : {};
    expect(offered(await render(data, { runs }))).toEqual(withRunner);
    expect(offered(await render(data, { runs: null }))).toEqual(withoutRunner);
  });
});

describe("the live log and taking control", () => {
  const conversation = {
    state: "idle",
    updatedAt: "2026-11-02T11:00:00.000Z",
    hasLog: true,
    conversation: true,
  } as FactoryRunView;

  it("shows the run's log in the dialog, followed live, next to the answer card", async () => {
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      runs: {
        "acme-onboarding": { ...waiting, hasLog: true } as FactoryRunView,
      },
    });
    const dialog = dialogMarkup(markup, "acme-onboarding");
    expect(dialog).toContain('data-outcome-log="/api/factory/worksets/acme-onboarding/log/stream"');
    expect(dialog).toContain('name="answer"');
    expect(dialog).not.toContain("data-outcome-terminal");
    expect(
      await render(payload({ worksets: [outcome(started())] }), {
        runs: { "acme-onboarding": running("explore") },
      }),
    ).toContain("data-outcome-log");
    // Nothing logged and nothing running: no log.
    expect(
      await render(payload({ worksets: [outcome(started())] }), {
        runs: { "acme-onboarding": { state: "idle", updatedAt: "" } },
      }),
    ).not.toContain("data-outcome-log");
  });

  it("leads with the log for a running Outcome, and puts it under a waiting question", async () => {
    const runningDialog = dialogMarkup(
      await render(payload({ worksets: [outcome(started())] }), {
        runs: { "acme-onboarding": running("explore") },
      }),
      "acme-onboarding",
    );
    const main = runningDialog.slice(runningDialog.indexOf('class="outcome-dialog-main"'));
    expect(main).toMatch(/^class="outcome-dialog-main"><section class="outcome-log-section"/);
    expect(main.indexOf("outcome-log-section")).toBeLessThan(main.indexOf("outcome-dialog-status"));
    expect(main.indexOf("outcome-dialog-status")).toBeLessThan(
      main.indexOf('aria-label="Run actions"'),
    );
    const waitingDialog = dialogMarkup(
      await render(payload({ worksets: [outcome(started())] }), {
        runs: {
          "acme-onboarding": { ...waiting, hasLog: true } as FactoryRunView,
        },
      }),
      "acme-onboarding",
    );
    expect(waitingDialog).toMatch(
      /aria-label="Needs you">.*?<\/section><section class="outcome-log-section"/s,
    );
    // The log names itself and can be scrolled by keyboard.
    expect(waitingDialog).toMatch(/role="log" aria-label="Run log" tabindex="0"/);
  });

  it("offers Take control only for a saved conversation, saying what it does", async () => {
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      runs: { "acme-onboarding": conversation },
    });
    expect(dialogMarkup(markup, "acme-onboarding")).toContain("/acme-onboarding/take-control");
    expect(dialogMarkup(markup, "acme-onboarding")).toContain(
      "Pauses automation after the current stage; you continue the factory&#x27;s own conversation here.",
    );
    expect(
      await render(payload({ worksets: [outcome(started())] }), {
        runs: { "acme-onboarding": { state: "idle", updatedAt: "" } },
      }),
    ).not.toContain("take-control");
  });

  it("says control passes after the current stage while a takeover waits", async () => {
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      sessions: {},
      runs: {
        "acme-onboarding": {
          ...running("apply"),
          conversation: true,
          control: { mode: "takeover-requested", updatedAt: "" },
        } as FactoryRunView,
      },
    });
    const dialog = dialogMarkup(markup, "acme-onboarding");
    expect(dialog).toMatch(
      /aria-label="Taking control".*?Control passes to you once the .*?apply.*? stage ends/s,
    );
    // The waiting note leads, the live log follows it directly.
    expect(dialog).toMatch(
      /aria-label="Taking control".*?<\/section><section class="outcome-log-section"/s,
    );
    expect(dialog).not.toContain("/take-control");
    // The session starts only once control passed.
    expect(dialog).not.toContain("data-outcome-terminal");
  });

  it("lists a manual Outcome under Needs you with its session and Return to automation", async () => {
    const markup = await render(payload({ worksets: [outcome(started())] }), {
      sessions: {},
      runs: {
        "acme-onboarding": {
          ...conversation,
          control: {
            mode: "manual",
            reason: "returning to automation failed: acme",
            updatedAt: "",
          },
        } as FactoryRunView,
      },
    });
    expect(sectionMarkup(markup, "attention")).toContain("You have control");
    const dialog = dialogMarkup(markup, "acme-onboarding");
    expect(dialog).toContain('data-outcome-terminal="acme-onboarding"');
    expect(dialog).toContain('data-companion="0123456789"');
    expect(dialog).not.toContain("data-terminal-workset");
    expect(dialog).toContain("/acme-onboarding/return");
    expect(dialog).toContain("returning to automation failed: acme");
    // The control layout: the way back above the terminal, and no map narrowing it.
    expect(dialog).toContain('data-layout="control"');
    expect(dialog.indexOf("/acme-onboarding/return")).toBeLessThan(
      dialog.indexOf("data-outcome-terminal"),
    );
    expect(dialog).not.toContain("workflow-graph-nodes");
    expect(dialog).toContain("outcome-facts");
    expect(dialog).not.toContain("/take-control");
  });

  it("names what each attention expects in the Outcome's panel", async () => {
    const markup = await render(
      payload({
        worksets: [
          outcome({ id: "acme-a", title: "A", ...started() }),
          outcome({
            id: "acme-b",
            title: "B",
            stage: "apply",
            stageLabel: "Apply",
            ...started(),
          }),
        ],
      }),
      { runs: { "acme-a": { ...waiting }, "acme-b": running() } },
    );
    const first = dialogMarkup(markup, "acme-a");
    expect(first).toContain("The run is paused on this.");
    expect(dialogMarkup(markup, "acme-b")).not.toContain("outcome-dialog-attention");
    expect(markup).toContain("data-outcome-filter");
  });

  it("explains the journey before the first Outcome", async () => {
    const markup = await render(payload());
    expect(markup).toContain("How an outcome gets delivered");
    expect(markup).not.toContain("data-outcome-filter=");
  });
});
