import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { workflowPlan } from "./steps";

const skillsRoot = path.join(import.meta.dir, "../../../../../templates/mate-skills/claude");

/**
 * Terms each stage's Studio text claims; the stage's skill must still say them.
 * Drift guard: a skill dropping a behaviour fails here until the Studio text follows.
 */
const STAGE_CLAIMS: Record<string, string[]> = {
  "clarify-intent": ["success"],
  explore: ["context map", "slic"],
  propose: ["minimal", "slic"],
  apply: ["delivery branch", "protected"],
  "inspect-outcome": ["diagram", "diff"],
  "refine-code": ["behavior"],
  archive: ["canonical", "delivery"],
  publish: ["merged", "tag"],
};

describe("Studio stage text", () => {
  const steps = workflowPlan().paths[0].steps.filter((step) => step.kind === "skill");

  it("names a claim set for every skill stage", () => {
    expect(steps.map((step) => step.id).sort()).toEqual(Object.keys(STAGE_CLAIMS).sort());
  });

  for (const [id, terms] of Object.entries(STAGE_CLAIMS)) {
    it(`${id} text and skill agree on ${terms.join(", ")}`, () => {
      const step = steps.find((entry) => entry.id === id);
      if (!step || step.kind !== "skill") throw new Error(`no skill stage ${id}`);
      const skill = fs
        .readFileSync(path.join(skillsRoot, step.skill, "SKILL.md"), "utf8")
        .toLowerCase();
      for (const term of terms) {
        expect(step.what.toLowerCase()).toContain(term);
        expect(skill).toContain(term);
      }
    });
  }
});
