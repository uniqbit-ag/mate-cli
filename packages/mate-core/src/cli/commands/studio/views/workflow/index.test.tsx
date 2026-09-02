/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioCompanionPayload } from "../../payload";
import { Workflow } from "./index";
import { workflowSteps } from "./steps";

function payload(overrides: Partial<StudioCompanionPayload> = {}): StudioCompanionPayload {
  return {
    companionPath: "/home/dev/.mate/companions/acme-companion",
    changes: [],
    specs: [],
    topology: null,
    warnings: [],
    ...overrides,
  };
}

function render(data: StudioCompanionPayload = payload()): string {
  return String(<Workflow payload={data} />);
}

describe("workflowSteps", () => {
  it("shows the static OpenSpec and Mate skill sequence", () => {
    const steps = workflowSteps();
    expect(steps.map((step) => step.id)).toEqual([
      "grill",
      "explore",
      "propose",
      "apply",
      "simplify",
      "finish",
    ]);
    expect(steps.map((step) => step.kind)).toEqual([
      "optional",
      "skill",
      "skill",
      "skill",
      "optional",
      "completion",
    ]);
  });

  it("puts a grilling questionnaire before explore", () => {
    const step = workflowSteps()[0];
    expect(step?.optional).toBe(true);
    expect(step?.title).toBe("grill / questionnaire");
    expect(step?.what).toContain("3-5 high-leverage questions");
    expect(step?.prompt).toContain("/grill-me");
    expect(step?.prompt).toContain("/interview-me");
    expect(step?.prompt).toContain("<change-name>");
  });

  it("puts optional code simplification after apply and before finish", () => {
    const steps = workflowSteps();
    const simplify = steps.find((step) => step.id === "simplify");
    expect(simplify?.optional).toBe(true);
    expect(simplify?.what).toContain("preserving behavior");
    expect(simplify?.prompt).toContain("/mate-simplify-code");
    expect(steps.indexOf(simplify!)).toBe(steps.findIndex((step) => step.id === "apply") + 1);
  });

  it("shows the skill invocation needed for each stage", () => {
    const steps = workflowSteps();
    expect(steps.find((step) => step.id === "explore")?.prompt).toContain("/openspec-explore");
    expect(steps.find((step) => step.id === "propose")?.prompt).toContain("/openspec-propose");
    expect(steps.find((step) => step.id === "apply")?.prompt).toContain("/openspec-apply-change");
    expect(steps.find((step) => step.id === "propose")?.prompt).toContain(
      "proposal, specs, design, and tasks",
    );
    expect(steps.find((step) => step.id === "finish")?.prompt).toContain("/mate-artifact-finish");
    expect(steps.find((step) => step.id === "finish")?.prompt).toContain(
      'mate artifact finish "<change-name>" --json',
    );
  });

  it("states what every stage does and why it is in the sequence", () => {
    for (const step of workflowSteps()) {
      expect({ id: step.id, what: step.what.length > 0 }).toEqual({ id: step.id, what: true });
      expect({ id: step.id, why: step.why.length > 0 }).toEqual({ id: step.id, why: true });
      expect(step.what).not.toBe(step.why);
    }
    const finish = workflowSteps().find((step) => step.id === "finish");
    expect(finish?.what).toContain("delta specs");
    expect(finish?.why).toContain("only sanctioned completion");
  });

  it("keeps the change placeholder in every prompt", () => {
    expect(workflowSteps().every((step) => step.prompt.includes("<change-name>"))).toBe(true);
  });
});

describe("Workflow", () => {
  it("renders optional labels, what/why boxes, and one copy control per stage", () => {
    const markup = render();
    expect(markup).toContain("<h2>Workflow</h2>");
    expect(markup.match(/class="runway-step-copy"/g)).toHaveLength(6);
    expect(markup.match(/class="runway-step-optional">Optional</g)).toHaveLength(2);
    expect(markup.match(/class="runway-step-facet runway-step-what"/g)).toHaveLength(6);
    expect(markup.match(/class="runway-step-facet runway-step-why"/g)).toHaveLength(6);
    expect(markup.match(/<strong>What<\/strong>/g)).toHaveLength(6);
    expect(markup.match(/<strong>Why<\/strong>/g)).toHaveLength(6);
    expect(markup).toContain("grill / questionnaire");
    expect(markup).toContain("mate simplify code");
    expect(markup).toContain('data-copy-label="grill / questionnaire prompt"');
  });

  it("renders the built-in workflow without a resolved schema", () => {
    const markup = render(payload());
    expect(markup).toContain("<h2>Workflow</h2>");
    expect(markup).toContain("openspec propose");
  });
});
