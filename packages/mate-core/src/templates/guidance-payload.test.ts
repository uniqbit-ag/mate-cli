import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { buildCompanionGuidance } from "../runtime/companion-guidance";

/**
 * Model-visible Mate guidance, in UTF-8 bytes (not tokens). Baselines were captured
 * before reduce-workflow-token-overhead, with the same sanitized inputs.
 */
const BASELINE = {
  policy: 5782,
  "mate-v1/schema.yaml": 12204,
  "mate-minimal/schema.yaml": 3646,
  "mate-propose-change/SKILL.md": 6905,
  "mate-apply-change/SKILL.md": 5078,
  conventions: 4607,
};

/** Before the change, every stage below read the whole conventions file. */
const STAGE_SECTIONS: Record<string, string[]> = {
  "mate-v1 proposal": ["rules"],
  "mate-v1 specs": ["rules", "spec_rules"],
  "mate-v1 design": ["rules"],
  "mate-v1 tasks": ["rules", "skill_tagging", "verification"],
  "mate-v1 apply": ["verification"],
  "mate-minimal specs": ["rules", "spec_rules"],
  "mate-minimal tasks": ["rules", "skill_tagging", "verification"],
  "mate-minimal apply": ["verification"],
};

const capRoot = path.join(import.meta.dir, "capabilities", "openspec-cap");
const skillsRoot = path.join(import.meta.dir, "mate-skills", "claude");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const read = (file: string) => fs.readFile(file, "utf8");

type Schema = {
  artifacts: { id: string; instruction: string }[];
  apply: { instruction: string };
};

/** The raw text of a top-level YAML key, from its key line to the next one. */
function sectionOf(raw: string, key: string): string {
  const lines = raw.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) throw new Error(`no section ${key}`);
  const end = lines.findIndex((line, index) => index > start && /^[a-z_]+:/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** What a key-line lookup such as `grep -n '^[a-z_]*:'` prints. */
function sectionIndex(raw: string): string {
  return raw
    .split("\n")
    .map((line, index) => (/^[a-z_]+:/.test(line) ? `${index + 1}:${line}` : null))
    .filter((line) => line !== null)
    .join("\n");
}

function policy(): string {
  return buildCompanionGuidance(
    {
      companionPath: "/home/acme/.mate/companions/acme-companion",
      repository: { id: "acme", path: "/home/acme/code/acme" },
      capabilities: [{ name: "openspec" }, { name: "tokensave" }],
    },
    { wrapperBinPath: "/opt/acme/wrappers/bin" },
  );
}

describe("workflow guidance payload", () => {
  test("conventions are split into stage sections that keep every obligation", async () => {
    const raw = await read(path.join(capRoot, "openspec-conventions.yaml"));
    const parsed = parse(raw) as Record<string, string>;

    expect(sectionOf(raw, "rules")).toContain("Preserve each repository/Area pair");
    expect(sectionOf(raw, "rules")).not.toContain("canonical spec uses flat frontmatter");
    expect(parsed.spec_rules).toContain("OpenSpec parses only ## ADDED Requirements");
    expect(parsed.spec_rules).toContain("Every requirement MUST carry an Area marker");
    expect(parsed.canonical_rules).toContain("A canonical spec uses flat frontmatter");
    expect(parsed.canonical_rules).toContain("split the capability before archive");
    expect(parsed.verification).toContain("mate-react-doctor");
    expect(parsed.skill_tagging).toContain("Never tag user-global");
  });

  test("each stage names only the sections it needs, with a safe full-read fallback", async () => {
    for (const name of ["mate-v1", "mate-minimal"]) {
      const schema = parse(await read(path.join(capRoot, name, "schema.yaml"))) as Schema;
      const instructions: Record<string, string> = Object.fromEntries([
        ...schema.artifacts.map((artifact) => [artifact.id, artifact.instruction]),
        ["apply", schema.apply.instruction],
      ]);
      for (const [stage, sections] of Object.entries(STAGE_SECTIONS)) {
        const [schemaName, id] = stage.split(" ");
        if (schemaName !== name) continue;
        const instruction = instructions[id] ?? "";
        for (const section of sections) expect(instruction).toContain(`\`${section}\``);
        if (id !== "apply") {
          expect(instruction.replace(/\s+/g, " ")).toMatch(
            /never fixed line numbers|same selection rule/,
          );
        }
        if (id === "proposal" || id === "design") {
          for (const unrelated of ["verification", "skill_tagging", "spec_rules"]) {
            expect(instruction).not.toContain(`\`${unrelated}\``);
          }
        }
      }
    }
  });

  test("schemas leave structural examples to their templates", async () => {
    const raw = await read(path.join(capRoot, "mate-v1", "schema.yaml"));
    expect(raw).not.toContain("type: change-proposal");
    expect(raw).not.toContain("type: change-design");
    expect(raw).not.toContain("type: change-tasks");
    expect(raw).not.toContain("- [ ] 1.1 Create new module structure");
    expect(raw).toContain("Start with the template's frontmatter");
  });

  test("aggregate Mate guidance shrinks, counting section lookups", async () => {
    const conventions = await read(path.join(capRoot, "openspec-conventions.yaml"));
    const lookup = bytes(sectionIndex(conventions));
    const current = {
      policy: bytes(policy()),
      "mate-v1/schema.yaml": bytes(await read(path.join(capRoot, "mate-v1", "schema.yaml"))),
      "mate-minimal/schema.yaml": bytes(
        await read(path.join(capRoot, "mate-minimal", "schema.yaml")),
      ),
      "mate-propose-change/SKILL.md": bytes(
        await read(path.join(skillsRoot, "mate-propose-change", "SKILL.md")),
      ),
      "mate-apply-change/SKILL.md": bytes(
        await read(path.join(skillsRoot, "mate-apply-change", "SKILL.md")),
      ),
    };
    const stages = Object.values(STAGE_SECTIONS);
    const conventionReads = stages.reduce(
      (sum, sections) =>
        sum + lookup + sections.reduce((acc, key) => acc + bytes(sectionOf(conventions, key)), 0),
      0,
    );
    const baselineReads = stages.length * BASELINE.conventions;
    const before =
      Object.entries(BASELINE).reduce(
        (sum, [key, value]) => (key === "conventions" ? sum : sum + value),
        0,
      ) + baselineReads;
    const after = Object.values(current).reduce((sum, value) => sum + value, 0) + conventionReads;

    expect(current.policy).toBeLessThan(BASELINE.policy);
    expect(current["mate-v1/schema.yaml"]).toBeLessThan(BASELINE["mate-v1/schema.yaml"]);
    expect(current["mate-propose-change/SKILL.md"]).toBeLessThan(
      BASELINE["mate-propose-change/SKILL.md"],
    );
    expect(conventionReads).toBeLessThan(baselineReads);
    expect(after).toBeLessThan(before);
  });
});
