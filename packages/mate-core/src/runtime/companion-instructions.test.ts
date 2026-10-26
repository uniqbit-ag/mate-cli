import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  COMPANION_INSTRUCTIONS_BUDGET,
  COMPANION_INSTRUCTIONS_TAG,
  buildCompanionInstructions,
  companionClaudeMdHasOwnText,
  type CompanionInstructions,
} from "./companion-instructions";
import { managedBlockMarkers } from "./managed-block";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const RULE = "Code comments: JSDoc format only, never `//`.";
const MANAGED_BLOCK = [
  "<!-- MATE:COMPANION:START -->",
  "",
  `- ${RULE}`,
  "- Never commit in the working repo (`$MATE_REPO_PATH`) unless asked.",
  "",
  "<!-- MATE:COMPANION:END -->",
].join("\n");

function managedBlock(key: string, body: string): string {
  const { start, end } = managedBlockMarkers("mate", key);
  return `${start}\n${body}\n${end}`;
}

function companion(files: { agents?: string; claude?: string; override?: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acme-companion-instructions-"));
  tempRoots.push(dir);
  if (files.agents !== undefined) fs.writeFileSync(path.join(dir, "AGENTS.md"), files.agents);
  if (files.claude !== undefined) fs.writeFileSync(path.join(dir, "CLAUDE.md"), files.claude);
  if (files.override !== undefined) {
    fs.writeFileSync(path.join(dir, "AGENTS.override.md"), files.override);
  }
  return dir;
}

function build(companionPath: string): CompanionInstructions {
  return buildCompanionInstructions({
    companionPath,
    repository: { id: "acme", path: "/work/app" },
    wrapperBinPath: "/install/acme/wrappers/bin",
    runtime: "claude",
  });
}

function text(result: CompanionInstructions): string {
  if (result.kind !== "available") throw new Error(`unavailable: ${result.reason}`);
  return result.text;
}

function section(heading: string, length: number): string {
  const line = `- ${heading} rule.`;
  const body = Array.from({ length: Math.ceil(length / (line.length + 1)) }, () => line);
  return `## ${heading}\n\n${body.join("\n")}`;
}

describe("buildCompanionInstructions content", () => {
  test("keeps the managed block's rules and the user's own sections", () => {
    const dir = companion({ agents: `${MANAGED_BLOCK}\n\n## Git\n\n- Rebase, never merge.\n` });

    const result = text(build(dir));

    expect(result).toContain(RULE);
    expect(result).toContain("## Git\n\n- Rebase, never merge.");
  });

  test("wraps the text in one element naming the absolute AGENTS.md", () => {
    const dir = companion({ agents: MANAGED_BLOCK });

    const result = text(build(dir));

    const source = path.join(dir, "AGENTS.md");
    expect(result.startsWith(`<${COMPANION_INSTRUCTIONS_TAG} source="${source}">`)).toBe(true);
    expect(result.endsWith(`</${COMPANION_INSTRUCTIONS_TAG}>`)).toBe(true);
    expect(result.split(`<${COMPANION_INSTRUCTIONS_TAG}`)).toHaveLength(2);
  });

  test("drops the managed blocks another runtime's surface wrote to AGENTS.md", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n${managedBlock("context-mode:abc123", "## Context Mode\n\nOpenCode only.")}\n`,
    });

    const result = text(build(dir));

    expect(result).not.toContain("OpenCode only.");
    expect(result).not.toContain("Context Mode");
  });

  test("adds the Claude-targeted managed blocks from CLAUDE.md and none of its free text", () => {
    const dir = companion({
      agents: MANAGED_BLOCK,
      claude: [
        "@AGENTS.md",
        "",
        managedBlock("context-mode:abc123", "## Context Mode\n\nClaude block body."),
        "",
        "## Stale notes",
        "",
        "Free text only companion sessions read.",
      ].join("\n"),
    });

    const result = text(build(dir));

    expect(result).toContain("## Context Mode\n\nClaude block body.");
    expect(result).not.toContain("Free text only companion sessions read.");
    expect(result).not.toContain("Stale notes");
  });

  test("fills $MATE_* placeholders for the session's repository and companion", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\nArtifacts: $MATE_ARTIFACT_PATH; bin: \${MATE_WRAPPER_BIN_PATH}; id: $MATE_REPO_ID.\n`,
    });

    const result = text(build(dir));

    expect(result).toContain("`/work/app`");
    expect(result).toContain(`Artifacts: ${dir}; bin: /install/acme/wrappers/bin; id: acme.`);
    expect(result).not.toMatch(/\$\{?MATE_(REPO_PATH|ARTIFACT_PATH|WRAPPER_BIN_PATH|REPO_ID)/);
  });

  test.each(["$MATE_REPO_PATHbackup", "$MATE_REPO_IDx"])(
    "leaves %s as written: an unknown placeholder is never partly filled",
    (unknown) => {
      const dir = companion({
        agents: `${MANAGED_BLOCK}\n\nKeep ${unknown} and $MATE_REPO_PATH/src.\n`,
      });

      expect(text(build(dir))).toContain(`Keep ${unknown} and /work/app/src.`);
    },
  );

  test("strips HTML comments, the block markers included", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n<!-- a note\nover two lines -->\n## Git\n\n- Rebase.\n`,
    });

    const result = text(build(dir));

    expect(result).not.toContain("<!--");
    expect(result).not.toContain("a note");
    expect(result).toContain("## Git");
  });

  test("leaves @ import lines literal", () => {
    const dir = companion({ agents: `${MANAGED_BLOCK}\n\n@docs/extra.md\n` });
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs", "extra.md"), "Imported body.");

    const result = text(build(dir));

    expect(result).toContain("@docs/extra.md");
    expect(result).not.toContain("Imported body.");
  });

  test("never reads AGENTS.override.md", () => {
    const dir = companion({ agents: MANAGED_BLOCK, override: "Override rule." });

    expect(text(build(dir))).not.toContain("Override rule.");
  });
});

describe("buildCompanionInstructions comments and fences", () => {
  test("a comment spanning a heading hides the heading and its text", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Keep\n\nkept\n\n<!-- commented out:\n## Old Rules\nSECRET\n-->\n\n## After\n\nafter\n`,
    });

    const result = build(dir);
    const delivered = text(result);

    expect(delivered).not.toContain("<!--");
    expect(delivered).not.toContain("Old Rules");
    expect(delivered).not.toContain("SECRET");
    expect(delivered).toContain("## Keep\n\nkept");
    expect(delivered).toContain("## After\n\nafter");
    expect(result.kind === "available" && result.omitted).toEqual([]);
  });

  test("a comment that does not open its line is text, as Claude Code keeps it", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Git\n\nRebase <!-- always --> first.\n    <!-- four spaces: code -->\n`,
    });

    const delivered = text(build(dir));

    expect(delivered).toContain("Rebase <!-- always --> first.\n    <!-- four spaces: code -->");
  });

  test("a comment delimiter mentioned in prose keeps every later section", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Specs\n\nEach delta spec starts with a \`<!-- mate:delta\` comment.\n\n## Git\n\n- Never force-push.\n`,
    });

    const delivered = text(build(dir));

    expect(delivered).toContain("starts with a `<!-- mate:delta` comment.");
    expect(delivered).toContain("## Git\n\n- Never force-push.");
  });

  test("a block comment never closed is text, as Claude Code keeps it", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Notes\n\n<!-- open\n## Hidden\nstill there\n`,
    });

    const result = build(dir);
    const delivered = text(result);

    expect(delivered).toContain("## Notes\n\n<!-- open");
    expect(delivered).toContain("## Hidden\nstill there");
    expect(result.kind === "available" && result.omitted).toEqual([]);
  });

  test("the rest of a block comment's closing line stays, less further closed comments", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Git\n\n<!-- alpha\nbeta -->- Rebase. <!-- gamma --> <!-- delta\n`,
    });

    const delivered = text(build(dir));

    expect(delivered).toContain("## Git\n\n- Rebase.  <!-- delta");
    expect(delivered).not.toMatch(/alpha|beta|gamma/);
  });

  test("a comment inside fenced code is code and stays verbatim", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Templates\n\n\`\`\`html\n<!-- keep me -->\n\`\`\`\n`,
    });

    expect(text(build(dir))).toContain("```html\n<!-- keep me -->\n```");
  });

  test("a heading inside fenced code opens no section, whichever fence encloses it", () => {
    const code = [
      "## Code",
      "",
      "~~~",
      "```",
      "## Not a section",
      "```",
      "~~~",
      "",
      "````md",
      "```",
      "## Also not a section",
      "```",
      "````",
      "",
      "```",
      "``` not a closing fence",
      "## Still not a section",
      "```",
    ].join("\n");
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n${code}\n\n${section("Tail", 12_000)}\n`,
    });

    const result = build(dir);
    const delivered = text(result);

    expect(delivered).toContain(code);
    expect(delivered).not.toContain("Tail rule.");
    expect(result.kind === "available" && result.omitted).toEqual(["Tail"]);
  });

  test("a fence opener whose info string holds <!-- opens a fence and hides nothing after it", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Templates\n\n\`\`\`html <!-- info\n<p>x</p>\n\`\`\`\n\n## Critical\n\n- Critical rule.\n`,
    });

    const result = build(dir);
    const delivered = text(result);

    expect(delivered).toContain("```html <!-- info\n<p>x</p>\n```");
    expect(delivered).toContain("## Critical\n\n- Critical rule.");
    expect(result.kind === "available" && result.omitted).toEqual([]);
  });

  test("a fence closes only on spaces or tabs after the run, not other whitespace", () => {
    const code = "```\n``` \n## Not a section\n```";
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Code\n\n${code}\n\n${section("Tail", 12_000)}\n`,
    });

    const result = build(dir);

    expect(text(result)).toContain(code);
    expect(result.kind === "available" && result.omitted).toEqual(["Tail"]);
  });

  test("a backtick run with a backtick in its info string is inline code, not a fence", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Git\n\n\`\`\`foo\`\`\` is inline.\n\n${section("Tail", 12_000)}\n`,
    });

    const result = build(dir);

    expect(text(result)).toContain("## Git\n\n```foo``` is inline.");
    expect(result.kind === "available" && result.omitted).toEqual(["Tail"]);
  });

  test("a ### heading is no section boundary", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Git\n\n- Git rule.\n\n### Sub\n\n${"- Sub rule.\n".repeat(800)}`,
    });

    const result = build(dir);
    const delivered = text(result);

    expect(result.kind === "available" && result.omitted).toEqual(["Git"]);
    expect(delivered).not.toContain("- Git rule.");
    expect(delivered).not.toContain("### Sub");
  });

  test.each([
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("%s line endings render the same as LF", (_name, ending) => {
    const lf = `${MANAGED_BLOCK}\n\n## Git\n\n<!-- note -->\n\`\`\`\n## code\n\`\`\`\n\n## Testing\n\n- Test rule.\n`;
    const dir = companion({ agents: lf });
    const fromLf = text(build(dir));
    fs.writeFileSync(path.join(dir, "AGENTS.md"), lf.replaceAll("\n", ending));

    const converted = text(build(dir));

    expect(converted).toBe(fromLf);
    expect(converted).not.toContain("\r");
  });

  test("a ## heading indented by up to three spaces opens a section, as CommonMark reads it", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Git\n\nGit rule.\n    ## Four spaces is no heading\n\n   ## Big\n\n${"- Big rule.\n".repeat(800)}`,
    });

    const result = build(dir);

    expect(result.kind === "available" && result.omitted).toEqual(["Big"]);
    expect(text(result)).toContain("Git rule.\n    ## Four spaces is no heading");
  });

  test("a ## heading inside a list item opens no section, so dropping its section drops it too", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Deployment\n\n${"- Padding rule.\n".repeat(600)}- Staging sandbox only:\n\n  ## Steps\n\n  Run \`deploy\`.\n`,
    });

    const result = build(dir);

    expect(result.kind === "available" && result.omitted).toEqual(["Deployment"]);
    expect(text(result)).not.toContain("Run `deploy`.");
  });

  test("blank lines inside fenced code are kept, and runs elsewhere collapse to one", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Git\n\n\n\n- Git rule.\n\n\`\`\`sh\necho a\n\n\n\necho b\n\`\`\`\n`,
    });

    const delivered = text(build(dir));

    expect(delivered).toContain("## Git\n\n- Git rule.\n\n```sh\necho a\n\n\n\necho b\n```");
  });

  test.each([
    ["a list item", "- ```md\n  ## Sample\n  ", "\n  ```"],
    ["a numbered list item", "1. ```md\n   ## Sample\n   ", "\n   ```"],
    ["a list item, its content indented by a tab", "- ```md\n\t## Sample\n\t", "\n  ```"],
    ["a list item, its closer indented by a tab", "- ```md\n  ## Sample\n  ", "\n\t```"],
    ["a list item with a tab after its marker", "-\t```md\n\t## Sample\n\t", "\n\t```"],
    ["a list item's later line", "- Example\n\n    ```md\n    ## Sample\n    ", "\n  ```"],
  ])("a fence opened in %s hides no later section", (_name, open, close) => {
    const example = `${open}${"x".repeat(9_500)}${close}`;
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Examples\n\n${example}\n\n## Git\n\n- Never force-push.\n`,
    });

    const result = build(dir);

    expect(result.kind === "available" && result.omitted).toEqual(["Examples"]);
    expect(text(result)).toContain("## Git\n\n- Never force-push.");
  });

  test.each([
    ["content indented by a tab", "- ```md\n\t## Sample\n\n\n\tcode\n  ```"],
    ["a nested list item", "- - ```sh\n    a\n\n\n    b\n    ```"],
    ["a numbered list item's later line", "10. Example\n\n    ```md\n    a\n\n\n    b\n    ```"],
  ])("a list item's fence keeps its text verbatim with %s", (_name, example) => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Examples\n\n${example}\n\n## Git\n\n- Never force-push.\n`,
    });

    expect(text(build(dir))).toContain(
      `## Examples\n\n${example}\n\n## Git\n\n- Never force-push.`,
    );
  });

  test("a list item's fence ends with the item, so an unclosed one hides no later section", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Examples\n\n- \`\`\`md\n  code\n\n## Git\n\n- Never force-push.\n`,
    });

    const result = build(dir);

    expect(result.kind === "available" && result.omitted).toEqual([]);
    expect(text(result)).toContain("  code\n\n## Git\n\n- Never force-push.");
  });

  test("lines of only spaces or tabs are blank: outside fences a run collapses, inside it stays", () => {
    const filler = `${" ".repeat(90)}\n`.repeat(101);
    const fenced = "```\na\n \t\n\t\nb\n```";
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Git\n\nACME-GIT-RULE\n${filler}ACME-END-RULE\n\n${fenced}\n`,
    });

    const result = build(dir);

    expect(result.kind === "available" && result.omitted).toEqual([]);
    expect(text(result)).toContain(`ACME-GIT-RULE\n\nACME-END-RULE\n\n${fenced}`);
  });

  test("the rest of a comment's closing line is text: no heading and no fence opens there", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n## Git\n\n<!-- a --> \`\`\`\n- Git rule.\n<!-- b --> ## No section\n\n## Tail\n\n${"- Tail rule.\n".repeat(800)}`,
    });

    const result = build(dir);

    expect(result.kind === "available" && result.omitted).toEqual(["Tail"]);
    expect(text(result)).toContain("## Git\n\n ```\n- Git rule.\n ## No section");
  });
});

describe("buildCompanionInstructions budget", () => {
  test("a file within the budget is delivered whole, not oversized, with no omission line", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n${section("Git", 2_000)}\n\n${section("Testing", 2_000)}\n`,
    });

    const result = build(dir);

    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.omitted).toEqual([]);
    expect(result.oversized).toBe(false);
    expect(result.text).toContain("## Testing");
    expect(result.text).not.toContain("Sections not included here");
  });

  test("an instruction text of exactly the budget is delivered whole", () => {
    const base = `${MANAGED_BLOCK}\n\n## Git\n\n`;
    const overhead = text(build(companion({ agents: `${base}x` }))).length - 1;
    const dir = companion({
      agents: `${base}${"x".repeat(COMPANION_INSTRUCTIONS_BUDGET - overhead)}`,
    });

    const result = build(dir);

    expect(text(result)).toHaveLength(COMPANION_INSTRUCTIONS_BUDGET);
    expect(result.kind === "available" && result.omitted).toEqual([]);
  });

  test("an oversized file keeps the managed block and whole sections, then names the rest", () => {
    const sections = [
      section("Git", 3_000),
      section("Testing", 6_000),
      section("Style", 1_500),
      section("Deployment", 5_000),
    ];
    const dir = companion({ agents: `${MANAGED_BLOCK}\n\n${sections.join("\n\n")}\n` });

    const result = build(dir);
    const delivered = text(result);

    expect(delivered.length).toBeLessThanOrEqual(COMPANION_INSTRUCTIONS_BUDGET);
    expect(delivered).toContain(RULE);
    /** Whole sections in order while they fit; a later, smaller one still gets in. */
    expect(delivered).toContain(sections[0]!);
    expect(delivered).toContain(sections[2]!);
    expect(delivered).not.toContain("## Testing");
    expect(delivered).not.toContain("## Deployment");
    expect(result.kind === "available" && result.omitted).toEqual(["Testing", "Deployment"]);
    expect(result.kind === "available" && result.oversized).toBe(false);
    const lastLine = delivered.split("\n").at(-2);
    expect(lastLine).toBe(
      `Sections not included here: Testing, Deployment. Full text: ${path.join(dir, "AGENTS.md")}`,
    );
  });

  test("never cuts a section in the middle", () => {
    const dir = companion({ agents: `${MANAGED_BLOCK}\n\n${section("Huge", 12_000)}\n` });

    const delivered = text(build(dir));

    expect(delivered).not.toContain("Huge rule.");
    expect(delivered).toContain("Sections not included here: Huge.");
  });

  test("a CLAUDE.md block survives when the last AGENTS.md section is dropped", () => {
    /** No heading of its own, so only its own segment keeps it apart from the section before it. */
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n${section("Git", 1_000)}\n\n${section("Testing", 9_000)}\n`,
      claude: `@AGENTS.md\n\n${managedBlock("context-mode:abc123", "- Claude block rule.")}\n`,
    });

    const result = build(dir);
    const delivered = text(result);

    expect(delivered).toContain("- Claude block rule.");
    expect(delivered).toContain("## Git");
    expect(delivered).not.toContain("## Testing");
    expect(result.kind === "available" && result.omitted).toEqual(["Testing"]);
    expect(delivered.split("\n").at(-2)).toBe(
      `Sections not included here: Testing. Full text: ${path.join(dir, "AGENTS.md")}`,
    );
  });

  test("an omitted CLAUDE.md block is named by its plugin and the line names both files", () => {
    const dir = companion({
      agents: `${MANAGED_BLOCK}\n\n${section("Git", 1_000)}\n`,
      claude: managedBlock(
        "context-mode:abc123",
        `## Context Mode\n\n${"- Context rule.\n".repeat(600)}`,
      ),
    });

    const result = build(dir);
    const delivered = text(result);

    expect(delivered).toContain("## Git");
    expect(delivered).not.toContain("Context rule.");
    expect(delivered.length).toBeLessThanOrEqual(COMPANION_INSTRUCTIONS_BUDGET);
    expect(result.kind === "available" && result.omitted).toEqual(["CLAUDE.md block context-mode"]);
    expect(delivered.split("\n").at(-2)).toBe(
      `Sections not included here: CLAUDE.md block context-mode. Full text: ${path.join(dir, "AGENTS.md")} and ${path.join(dir, "CLAUDE.md")}`,
    );
  });

  test("a managed block beyond the budget is kept whole and the result is oversized", () => {
    const body = "- Block rule.\n".repeat(680);
    const block = `<!-- MATE:COMPANION:START -->\n\n${body}\n<!-- MATE:COMPANION:END -->`;
    const dir = companion({
      agents: `${block}\n\n${section("Git", 100)}\n\n${section("Testing", 100)}\n`,
    });

    const result = build(dir);
    const delivered = text(result);

    expect(body.length).toBeGreaterThan(COMPANION_INSTRUCTIONS_BUDGET);
    expect(result.kind === "available" && result.oversized).toBe(true);
    expect(delivered.length).toBeGreaterThan(COMPANION_INSTRUCTIONS_BUDGET);
    expect(delivered).toContain(body.trim());
    expect(delivered).not.toContain("## Git");
    expect(delivered).not.toContain("## Testing");
    expect(result.kind === "available" && result.omitted).toEqual(["Git", "Testing"]);
    /** No room is left under the budget, so the line lists the first name and counts the rest. */
    expect(delivered.split("\n").at(-2)).toBe(
      `Sections not included here: Git and 1 more. Full text: ${path.join(dir, "AGENTS.md")}`,
    );
  });

  test("a block that fills the budget leaves no room for a section and is oversized", () => {
    const blockOf = (filler: string) =>
      `<!-- MATE:COMPANION:START -->\n\n- ${filler}\n\n<!-- MATE:COMPANION:END -->`;
    const overhead = text(build(companion({ agents: blockOf("x") }))).length - 1;
    const dir = companion({
      agents: `${blockOf("x".repeat(COMPANION_INSTRUCTIONS_BUDGET - overhead - 10))}\n\n## Git\n\n- Git rule.\n`,
    });

    const result = build(dir);
    const delivered = text(result);

    const closing = `Sections not included here: Git. Full text: ${path.join(dir, "AGENTS.md")}`;
    expect(result.kind === "available" && result.oversized).toBe(true);
    expect(delivered.length).toBeGreaterThan(COMPANION_INSTRUCTIONS_BUDGET);
    expect(delivered.length).toBeLessThanOrEqual(COMPANION_INSTRUCTIONS_BUDGET + closing.length);
    expect(delivered).not.toContain("## Git");
    expect(delivered.split("\n").at(-2)).toBe(closing);
  });

  test("a block that leaves little room gets the omitted sections counted, not listed", () => {
    const blockOf = (filler: string) =>
      `<!-- MATE:COMPANION:START -->\n\n- ${filler}\n\n<!-- MATE:COMPANION:END -->`;
    const overhead = text(build(companion({ agents: blockOf("x") }))).length - 1;
    const sections = Array.from(
      { length: 300 },
      (_, index) => `## Rule ${index + 1}\n\n- Rule ${index + 1} text.`,
    );
    const dir = companion({
      agents: `${blockOf("x".repeat(COMPANION_INSTRUCTIONS_BUDGET - overhead - 10))}\n\n${sections.join("\n\n")}\n`,
    });

    const result = build(dir);
    const delivered = text(result);

    const closing = `Sections not included here: Rule 1 and 299 more. Full text: ${path.join(dir, "AGENTS.md")}`;
    expect(delivered.split("\n").at(-2)).toBe(closing);
    expect(delivered.length).toBeLessThanOrEqual(COMPANION_INSTRUCTIONS_BUDGET + closing.length);
    expect(result.kind === "available" && result.oversized).toBe(true);
  });

  test("an oversized block standing alone gets no omission line", () => {
    const body = "- Block rule.\n".repeat(680);
    const dir = companion({
      agents: `<!-- MATE:COMPANION:START -->\n\n${body}\n<!-- MATE:COMPANION:END -->\n`,
    });

    const result = build(dir);

    expect(result.kind === "available" && result.oversized).toBe(true);
    expect(result.kind === "available" && result.omitted).toEqual([]);
    expect(text(result)).not.toContain("Sections not included here");
  });

  test("hundreds of sections stay within the budget and the line counts the unlisted names", () => {
    const sections = Array.from(
      { length: 700 },
      (_, index) => `## Rule ${index + 1}\n\n- Rule ${index + 1} text.`,
    );
    const dir = companion({ agents: `${MANAGED_BLOCK}\n\n${sections.join("\n\n")}\n` });

    const result = build(dir);
    const delivered = text(result);

    expect(delivered.length).toBeLessThanOrEqual(COMPANION_INSTRUCTIONS_BUDGET);
    expect(result.kind === "available" && result.oversized).toBe(false);
    expect(delivered).toContain("## Rule 1\n\n- Rule 1 text.");
    const lastLine = delivered.split("\n").at(-2)!;
    expect(lastLine).toMatch(
      /^Sections not included here: Rule \d+, .* and \d+ more\. Full text: /,
    );
    expect(lastLine.length).toBeLessThan(600);
    expect(result.kind === "available" && result.omitted.length).toBeGreaterThan(300);
  });

  test("an over-long heading is shortened in the omission line", () => {
    const heading = "L".repeat(200);
    const dir = companion({ agents: `${MANAGED_BLOCK}\n\n${section(heading, 12_000)}\n` });

    const delivered = text(build(dir));

    expect(delivered).toContain(`Sections not included here: ${"L".repeat(79)}…. Full text:`);
    expect(delivered).not.toContain("L".repeat(80));
  });

  test("an over-long heading of astral characters is cut between characters, never inside one", () => {
    const heading = "𝒜".repeat(100);
    const dir = companion({ agents: `${MANAGED_BLOCK}\n\n${section(heading, 12_000)}\n` });

    const delivered = text(build(dir));

    expect(delivered).toContain(`Sections not included here: ${"𝒜".repeat(79)}…. Full text:`);
    expect(delivered.isWellFormed()).toBe(true);
  });

  test("the budget holds for every generated shape of sections and blocks", () => {
    for (const size of [40, 300, 1_500, 4_000, 8_800, 12_000]) {
      for (const count of [1, 3, 12]) {
        const sections = Array.from({ length: count }, (_, index) =>
          section(`S${index} ${"n".repeat(index * 7)}`, size),
        );
        const dir = companion({
          agents: `${MANAGED_BLOCK}\n\n${sections.join("\n\n")}\n`,
          claude: managedBlock("ctx:0ff", `## Ctx\n\n${"- Ctx rule.\n".repeat(size / 20 + 1)}`),
        });

        const result = build(dir);

        if (result.kind !== "available") throw new Error(result.reason);
        expect(result.oversized).toBe(false);
        expect(result.text.length).toBeLessThanOrEqual(COMPANION_INSTRUCTIONS_BUDGET);
        expect(result.text).toContain(RULE);
        if (result.omitted.length > 0) {
          expect(result.text).toContain("Sections not included here: ");
        } else {
          expect(result.text).not.toContain("Sections not included here: ");
        }
      }
    }
  });
});

describe("buildCompanionInstructions availability", () => {
  test("a missing AGENTS.md is a typed unavailable result naming the file", () => {
    const dir = companion({ claude: "@AGENTS.md" });

    const result = build(dir);

    expect(result).toEqual({
      kind: "unavailable",
      source: path.join(dir, "AGENTS.md"),
      reason: "not found",
    });
  });

  test("an unreadable AGENTS.md is unavailable, not thrown", () => {
    const dir = companion({});
    fs.mkdirSync(path.join(dir, "AGENTS.md"));

    const result = build(dir);

    expect(result.kind).toBe("unavailable");
    expect(result.source).toBe(path.join(dir, "AGENTS.md"));
  });

  test.skipIf(process.platform === "win32")(
    "a FIFO at AGENTS.md is unavailable instead of blocking the read",
    () => {
      const dir = companion({});
      execFileSync("mkfifo", [path.join(dir, "AGENTS.md")]);

      expect(build(dir)).toEqual({
        kind: "unavailable",
        source: path.join(dir, "AGENTS.md"),
        reason: "is not a regular file",
      });
    },
  );

  test("reads both files through its deps, guard and line endings included", () => {
    const files: Record<string, string> = {
      "/acme/AGENTS.md": `${MANAGED_BLOCK}\r\n\r\n## Git\r\n\r\n- Rebase.\r\n`,
      "/acme/CLAUDE.md": `@AGENTS.md\n${managedBlock("acme-plugin", "## Acme\n\nAcme block body.")}\n`,
    };
    const deps = {
      isFile: (file: string) => file in files,
      readFile: (file: string) => files[file]!,
    };
    const input = {
      companionPath: "/acme",
      repository: { id: "acme", path: "/work/app" },
      wrapperBinPath: "/install/acme/wrappers/bin",
      runtime: "claude" as const,
    };

    const delivered = text(buildCompanionInstructions(input, deps));

    expect(delivered).toContain("## Git\n\n- Rebase.");
    expect(delivered).toContain("Acme block body.");
    expect(delivered).not.toContain("\r");
    expect(companionClaudeMdHasOwnText("/acme", deps)).toBe(false);
    expect(buildCompanionInstructions(input, { ...deps, isFile: () => false })).toEqual({
      kind: "unavailable",
      source: "/acme/AGENTS.md",
      reason: "is not a regular file",
    });
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(
      buildCompanionInstructions(input, {
        ...deps,
        readFile: () => {
          throw denied;
        },
      }),
    ).toEqual({
      kind: "unavailable",
      source: "/acme/AGENTS.md",
      reason: "could not be read (EACCES)",
    });
  });

  test("a missing CLAUDE.md contributes no blocks and is no failure", () => {
    const dir = companion({ agents: MANAGED_BLOCK });

    expect(build(dir).kind).toBe("available");
  });
});
