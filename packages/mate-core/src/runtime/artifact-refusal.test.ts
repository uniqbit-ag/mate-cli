import path from "node:path";

import { describe, expect, test } from "bun:test";

import { ARTIFACT_REFUSAL_HEADLINE, artifactRefusal } from "./artifact-refusal";
import { FRAMEWORK_NAME } from "./framework";

const repoRoot = path.join(path.sep, "work", "acme");
const companion = path.join(path.sep, "companions", "acme");

describe("artifactRefusal", () => {
  test("opens with the framework-prefixed headline", () => {
    const message = artifactRefusal({
      target: path.join(repoRoot, "plan.md"),
      resolved: path.join(repoRoot, "plan.md"),
      companion,
      repoRoot,
    });
    expect(ARTIFACT_REFUSAL_HEADLINE).toBe(
      "artifact writes must go to the companion framework path.",
    );
    expect(message.split("\n")[0]).toBe(
      `${FRAMEWORK_NAME} guardrail: ${ARTIFACT_REFUSAL_HEADLINE}`,
    );
    expect(message.endsWith("\n")).toBe(false);
  });

  test("a relative target inside the repository names its resolution, the reason and a suggestion", () => {
    const message = artifactRefusal({
      target: "notes/handoff.md",
      resolved: path.join(repoRoot, "notes", "handoff.md"),
      companion,
      repoRoot,
    });
    expect(message).toContain(" target:    notes/handoff.md");
    expect(message).toContain(` resolved:  ${path.join(repoRoot, "notes", "handoff.md")}`);
    expect(message).toContain(` companion: ${companion}`);
    expect(message).toContain(` suggested: ${path.join(companion, "notes", "handoff.md")}`);
    expect(message).toContain("Relative paths resolve against the working repository");
    expect(message).toContain("`cd` is not followed");
    expect(message).toContain("Rewrite to the suggested absolute path and retry.");
  });

  test("an absolute target inside the repository gets a suggestion but no resolution line", () => {
    const target = path.join(repoRoot, "scratch", "plan.md");
    const message = artifactRefusal({ target, resolved: target, companion, repoRoot });
    expect(message).toContain(` suggested: ${path.join(companion, "scratch", "plan.md")}`);
    expect(message).not.toContain("resolved:");
    expect(message).not.toContain("Relative paths resolve");
  });

  test("a target outside the repository gets no suggestion", () => {
    const target = path.join(path.sep, "elsewhere", "notes.md");
    const message = artifactRefusal({ target, resolved: target, companion, repoRoot });
    expect(message).toContain(` companion: ${companion}`);
    expect(message).not.toContain("suggested:");
    expect(message).not.toContain("..");
    expect(message).toContain(`Use an absolute path under ${companion}.`);
  });

  test("a CLAUDE.md target keeps the companion note last", () => {
    const message = artifactRefusal({
      target: "CLAUDE.md",
      resolved: path.join(repoRoot, "CLAUDE.md"),
      companion,
      repoRoot,
    });
    const lines = message.split("\n");
    expect(lines.at(-1)).toBe(
      `Note: CLAUDE.md already lives in the companion repo at ${companion}/CLAUDE.md.`,
    );
  });
});
