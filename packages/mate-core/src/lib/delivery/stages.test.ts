import { describe, expect, test } from "bun:test";

import { DELIVERY_STAGE_SKILLS, deliveryPath, SCHEMA_ARTIFACTS } from "./stages";

const labels = (artifacts: readonly string[] | undefined): string[] =>
  deliveryPath(artifacts).stages.map((stage) => stage.label);

describe("deliveryPath", () => {
  test("the full schema yields one review stage per artifact in schema order", () => {
    expect(labels(SCHEMA_ARTIFACTS["mate-v1"])).toEqual([
      "Clarify intent",
      "Explore change",
      "Propose change",
      "Review proposal",
      "Review specs",
      "Review design",
      "Review tasks",
      "Apply change",
      "Inspect outcome",
      "Refine code",
      "Archive change",
      "Publish companion artifacts",
    ]);
  });

  test("the minimal schema yields only its own review stages around the shared stages", () => {
    expect(labels(SCHEMA_ARTIFACTS["mate-minimal"])).toEqual([
      "Clarify intent",
      "Explore change",
      "Propose change",
      "Review specs",
      "Review tasks",
      "Apply change",
      "Inspect outcome",
      "Refine code",
      "Archive change",
      "Publish companion artifacts",
    ]);
  });

  test("each skill stage maps to its skill and every review stage maps to none", () => {
    const stages = deliveryPath(SCHEMA_ARTIFACTS["mate-v1"]).stages;
    const skills = Object.fromEntries(stages.map((stage) => [stage.label, stage.skill]));
    expect(skills).toMatchObject({
      "Clarify intent": "mate-clarify-intent",
      "Explore change": "mate-explore-change",
      "Propose change": "mate-propose-change",
      "Apply change": "mate-apply-change",
      "Inspect outcome": "mate-show-me",
      "Refine code": "mate-simplify-code",
      "Archive change": "mate-archive-change",
      "Publish companion artifacts": "mate-publish-artifact",
    });
    for (const stage of stages.filter((entry) => entry.kind === "human")) {
      expect(stage.skill).toBeNull();
      expect(stage.artifact).toBeDefined();
    }
  });

  test("the stage label names the action and the skill is carried separately", () => {
    const archive = deliveryPath(SCHEMA_ARTIFACTS["mate-v1"]).stages.find(
      (stage) => stage.id === "archive",
    );
    expect(archive).toMatchObject({ label: "Archive change", skill: "mate-archive-change" });
  });

  test("optional stages are independent peers and never required", () => {
    const stages = deliveryPath(SCHEMA_ARTIFACTS["mate-v1"]).stages;
    const optional = stages.filter((stage) => stage.optional).map((stage) => stage.id);
    expect(optional).toEqual(["clarify-intent", "inspect-outcome", "refine-code"]);
    const required = stages.filter((stage) => !stage.optional).map((stage) => stage.id);
    expect(required).toContain("archive");
    expect(required).toContain("publish");
  });

  test("an unavailable schema yields no review stages and says so", () => {
    const path = deliveryPath(undefined);
    expect(path.reviewsKnown).toBe(false);
    expect(path.stages.some((stage) => stage.kind === "human")).toBe(false);
    expect(path.stages.map((stage) => stage.id)).toContain("apply");
  });

  test("a schema with other artifacts yields only those review stages", () => {
    expect(
      deliveryPath(["brief", "tasks"])
        .stages.filter((stage) => stage.kind === "human")
        .map((stage) => stage.label),
    ).toEqual(["Review brief", "Review tasks"]);
  });

  test("the skill list is the set of skill-driven stages", () => {
    expect(DELIVERY_STAGE_SKILLS).toEqual([
      "mate-clarify-intent",
      "mate-explore-change",
      "mate-propose-change",
      "mate-apply-change",
      "mate-show-me",
      "mate-simplify-code",
      "mate-archive-change",
      "mate-publish-artifact",
    ]);
  });
});
