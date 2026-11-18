import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workflowProblemLines } from "../hooks/session-banner";
import { getWrapperBinPath } from "../lib/package-paths";
import { buildCompanionGuidance as buildWithoutWorkflow } from "../runtime/companion-guidance";
import { WORKFLOW_FILE } from "../runtime/workflow/workflow";
import { buildCompanionGuidance } from "./companion-guidance";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function companion(declaration?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-guidance-"));
  dirs.push(dir);
  if (declaration !== undefined) {
    fs.mkdirSync(path.join(dir, ".mate", "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, WORKFLOW_FILE), declaration);
  }
  return dir;
}

const NOTES = `version: 1
artifacts:
  acme-notes:
    change: notes/{name}/
    published: [notes/index.md]
    archive: notes-history/{id}/
    publish:
      apply: { run: "acme-notes merge {change}" }
`;

const context = (companionPath: string) => ({
  companionPath,
  repository: { id: "acme", path: "/tmp/acme" },
  capabilities: [{ name: "openspec" }],
});

/** The guidance as it was before a companion could declare artifact types. */
const builtIn = (companionPath: string): string =>
  buildWithoutWorkflow(context(companionPath), { wrapperBinPath: getWrapperBinPath() });

describe("guidance per artifact type", () => {
  test("a declared type gets a reading rule built from its paths", () => {
    const dir = companion(NOTES);
    const guidance = buildCompanionGuidance(context(dir));

    expect(guidance).toContain('<rule id="artifact-acme-notes" severity="critical">');
    expect(guidance).toContain("notes/index.md is current");
    expect(guidance).toContain("A submitted folder under notes/ is not the truth");
    expect(guidance).toContain("read one only when the user names it");
    expect(guidance).toContain("notes-history/ is history.");
    // The built-in type's rule stays verbatim beside it.
    expect(guidance).toContain('<rule id="openspec-publish" severity="critical">');
    expect(guidance.replace(/\n {4}<rule id="artifact-acme-notes".*<\/rule>/, "")).toBe(
      builtIn(dir),
    );
  });

  test("without a declaration the guidance is unchanged, byte for byte", () => {
    const dir = companion();
    expect(buildCompanionGuidance(context(dir))).toBe(builtIn(dir));
  });

  test("an invalid declaration keeps the built-in rule and the banner names its problems", () => {
    const dir = companion(`${NOTES}publishing: { mode: single }\n`);

    expect(buildCompanionGuidance(context(dir))).toBe(builtIn(dir));
    expect(workflowProblemLines(dir)).toEqual([
      "workflow: .mate/config/workflow.yaml is invalid; its stages do not run until it is fixed",
      "  publishing: unknown key `publishing`",
    ]);
  });

  test("declared stages get one rule naming each skill stage with its entry skill", () => {
    const dir = companion(`version: 1
stages:
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]
  - id: review
    review: schema
  - id: security-review
    steps: [{ skill: acme-security-review }]
  - id: submit
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
    const guidance = buildCompanionGuidance(context(dir));

    expect(guidance.match(/<rule id="workflow-stages"/g)).toHaveLength(1);
    expect(guidance).toContain(
      "apply (mate-apply-change), security-review (acme-security-review), submit (mate-submit-change), publish (mate-publish-artifact).",
    );
    expect(guidance).toContain('mate workflow steps "<stage>" --json');
    expect(guidance).toContain('mate workflow done "<stage>" "<change>"');
    expect(guidance.replace(/\n {4}<rule id="workflow-stages".*<\/rule>/, "")).toBe(builtIn(dir));
  });

  test("a declaration without stages adds no stage rule", () => {
    expect(buildCompanionGuidance(context(companion(NOTES)))).not.toContain("workflow-stages");
  });

  test("an invalid declaration with stages adds no stage rule", () => {
    const dir = companion("version: 1\nstages:\n  - id: apply\n    steps: [{ skill: acme-a }]\n");
    expect(buildCompanionGuidance(context(dir))).toBe(builtIn(dir));
  });

  test("a valid or absent declaration adds nothing to the banner", () => {
    expect(workflowProblemLines(companion(NOTES))).toEqual([]);
    expect(workflowProblemLines(companion())).toEqual([]);
  });
});
