import { describe, expect, it } from "bun:test";

import type {
  FactoryRunView,
  StudioCompanionPayload,
  StudioWorkset,
} from "@uniqbit/mate-core/studio";
import {
  attentionKind,
  derivedSituation,
  factoryHome,
  milestonesOf,
  nextStepOf,
  PATH_STEPS,
  pathPositionOf,
  situationOf,
} from "./outcome";

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

describe("the home model", () => {
  it("names why an Outcome waits on a person, and running work never does", () => {
    expect(attentionKind(outcome(), waiting)).toBe("decision");
    expect(
      attentionKind(outcome(), { state: "failed", stage: "apply", reason: "x", updatedAt: "" }),
    ).toBe("problem");
    expect(attentionKind(outcome({ stage: "human-review" }), undefined)).toBe("review");
    expect(attentionKind(outcome({ stage: "merge-wait" }), undefined)).toBe("merge");
    expect(attentionKind(outcome({ stage: "publish" }), undefined)).toBe("publish");
    expect(attentionKind(outcome({ stage: "explore" }), running("explore"))).toBeNull();
  });

  it("lists decisions oldest first", () => {
    const home = factoryHome(
      [
        outcome({ id: "acme-new", stage: "human-review", ...started("2026-11-02T10:00:00.000Z") }),
        outcome({ id: "acme-old", stage: "human-review", ...started("2026-11-01T10:00:00.000Z") }),
      ],
      {},
    );
    expect(home.attention.map((item) => item.workset.id)).toEqual(["acme-old", "acme-new"]);
  });

  it("keeps unstarted Outcomes in Later and started ones active, in start order", () => {
    const home = factoryHome(
      [
        outcome({ id: "acme-saved" }),
        outcome({ id: "acme-b", ...started("2026-11-02T09:00:00.000Z") }),
        outcome({ id: "acme-a", ...started("2026-10-01T09:00:00.000Z") }),
        outcome({ id: "acme-done", stage: "done", ...started() }),
      ],
      {},
    );
    expect(home.later.map((item) => item.workset.id)).toEqual(["acme-saved"]);
    expect(home.active.map((item) => item.workset.id)).toEqual(["acme-a", "acme-b"]);
    expect(home.completed.map((item) => item.workset.id)).toEqual(["acme-done"]);
  });

  it("checks milestones past the stage and names the next step", () => {
    const review = outcome({ stage: "human-review", ...started() });
    expect(milestonesOf(review).map((milestone) => milestone.reached)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(nextStepOf(review, undefined)).toBe("Ready for your review");
    const building = outcome({ stage: "apply", ...started() });
    expect(milestonesOf(building)[3]).toEqual({ label: "Plan approved", reached: true });
    expect(nextStepOf(building, running())).toBe("The factory is building it");
    expect(nextStepOf(outcome(), undefined)).toBe("Saved for later");
    expect(nextStepOf(outcome(started()), waiting)).toBe("Waiting for your answer");
  });

  it("prefers the reported situation, and derives one from the stage without it", () => {
    const explore = outcome({ stage: "explore", ...started() });
    expect(situationOf(explore, running("explore")).text).toBe("Working out the approach.");
    const reported: FactoryRunView = {
      state: "idle",
      updatedAt: "",
      situations: [
        { text: "A three-step signup is ready for review.", at: "2026-11-02T11:00:00Z" },
      ],
    };
    expect(situationOf(outcome({ stage: "human-review", ...started() }), reported)).toMatchObject({
      text: "A three-step signup is ready for review.",
      at: "2026-11-02T11:00:00Z",
    });
    expect(derivedSituation(explore, { state: "queued", stage: "explore", updatedAt: "" })).toBe(
      "Waiting for a free slot.",
    );
    expect(
      derivedSituation(explore, {
        state: "queued",
        stage: "explore",
        waiting: "workset-slot",
        updatedAt: "",
      }),
    ).toBe("Waiting for a Workset slot.");
    expect(
      derivedSituation(explore, {
        state: "queued",
        stage: "apply",
        waiting: "build-slot",
        updatedAt: "",
      }),
    ).toBe("Waiting for a build slot.");
  });

  it("lets a failure override an older report", () => {
    const failed: FactoryRunView = {
      state: "failed",
      stage: "apply",
      reason: "tasks are still open",
      updatedAt: "",
      situations: [{ text: "Plan ready.", at: "2026-11-02T09:00:00Z" }],
    };
    expect(situationOf(outcome({ stage: "apply", ...started() }), failed).text).toBe(
      "Stopped: tasks are still open",
    );
  });
});

describe("the Delivery Path position", () => {
  const at = (stage: StudioWorkset["stage"], run?: FactoryRunView) =>
    pathPositionOf(outcome({ stage, ...started() }), run);
  const idle: FactoryRunView = { state: "idle", updatedAt: "" };

  it("has six steps, with clarify and explore as one", () => {
    expect(PATH_STEPS).toEqual([
      "Understand",
      "Propose change",
      "Human review",
      "Apply change",
      "Merge",
      "Publish",
    ]);
    expect(at("clarify-intent", running("explore")).current).toBe(0);
    expect(at("explore", running("explore")).current).toBe(0);
  });

  it("puts each stage on its step", () => {
    expect(at("propose", running("explore")).current).toBe(1);
    expect(at("human-review", idle).current).toBe(2);
    expect(at("apply", running()).current).toBe(3);
    expect(at("merge-wait", idle).current).toBe(4);
    expect(at("publish", idle).current).toBe(5);
  });

  it("marks every step done once delivered", () => {
    expect(at("done", idle)).toEqual({ current: PATH_STEPS.length, tone: "accent" });
  });

  it("marks no step for an Outcome saved for later", () => {
    expect(pathPositionOf(outcome(), undefined).current).toBe(-1);
  });

  it("colours the current step by state", () => {
    expect(at("human-review", idle).tone).toBe("why");
    expect(at("merge-wait", idle).tone).toBe("warn");
    expect(at("apply", waiting).tone).toBe("warn");
    expect(at("apply", running()).tone).toBe("accent");
    expect(at("apply", { state: "failed", stage: "apply", reason: "x", updatedAt: "" }).tone).toBe(
      "bad",
    );
    const control = { state: "idle", updatedAt: "", control: { mode: "manual" } };
    expect(at("apply", control as unknown as FactoryRunView).tone).toBe("why");
  });
});
