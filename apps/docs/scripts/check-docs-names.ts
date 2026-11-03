/**
 * Docs consistency check: Mate skill, retired skill, and removed OpenSpec names in the
 * authored pages must match what Mate ships and removes. Retired and OpenSpec names may
 * appear only between `{/* breaking:start *\/}` and `{/* breaking:end *\/}`. In the
 * first-change guide, the list after `{/* breaking:renamed *\/}` and the table after
 * `{/* breaking:openspec *\/}` must cover every retired skill and removed OpenSpec skill.
 * Fenced code is checked for retired and OpenSpec names only: it also holds unrelated
 * `mate-*` names, such as directories and services.
 * Parses the source text instead of importing it, so the check needs no Mate setup.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { walk } from "./lib.ts";

const root = join(import.meta.dir, "..");
const contentDir = join(root, "content", "docs");
const guideFile = join(contentDir, "scenarios", "first-change.mdx");
const coreSrc = join(root, "..", "..", "packages", "mate-core", "src");
const setupDir = join(coreSrc, "tools", "setup");
const capabilitiesDir = join(coreSrc, "templates", "capabilities");
const schemasDir = join(capabilitiesDir, "openspec-cap");

/** `mate-*` identifiers the docs name that are not skills or schemas. Trailing `-` is a prefix. */
const nonSkills = new Set(["mate-home", "mate-plugin-"]);

const BREAKING_START = "{/* breaking:start */}";
const BREAKING_END = "{/* breaking:end */}";

/** String entries of `const <name>[: type] = [...][ as const];` in a source file. */
function constArray(file: string, name: string): string[] {
  const source = readFileSync(file, "utf8");
  const match = new RegExp(
    `const ${name}\\s*(?::[^=]*)?=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const\\s*)?;`,
  ).exec(source);
  if (!match) throw new Error(`no ${name} array in ${relative(root, file)}`);
  const body = (match[1] ?? "").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)].map(([, value = ""]) => value);
}

function subdirs(dir: string): string[] {
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

const mateSkills = constArray(join(setupDir, "mate.ts"), "MATE_SKILLS");
const capabilitySkills = subdirs(capabilitiesDir).flatMap((capability) =>
  subdirs(join(capabilitiesDir, capability)).filter((skill) =>
    existsSync(join(capabilitiesDir, capability, skill, "SKILL.md")),
  ),
);
const shippedSkills = new Set([...mateSkills, ...capabilitySkills]);
const schemas = new Set(
  subdirs(schemasDir).filter((schema) => existsSync(join(schemasDir, schema, "schema.yaml"))),
);
const retiredSkills = constArray(join(setupDir, "mate.ts"), "RETIRED_MATE_SKILLS");
const openspecSkills = constArray(join(setupDir, "capabilities", "openspec.ts"), "OPENSPEC_SKILLS");
const openspecCommandIds = new Set(
  constArray(join(setupDir, "capabilities", "openspec.ts"), "OPENSPEC_COMMAND_IDS"),
);

interface Span {
  line: number;
  text: string;
  breaking: boolean;
  fenced: boolean;
}

/** Skill and command names in fenced code, which has no backticks to delimit them. */
const FENCED_NAME = /(?<![\w./@-])(\/?(?:mate|openspec)-[a-z0-9*-]+|\/opsx(?::[a-z*-]+)?)/g;

/**
 * Inline-code spans and names in fenced code, each flagged when inside a breaking note.
 * Unbalanced breaking markers are reported to `problems`.
 */
function codeSpans(source: string, page: string, problems: string[]): Span[] {
  const spans: Span[] = [];
  let fenced = false;
  let breaking = 0;
  source.split("\n").forEach((line, index) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      for (const [, text = ""] of line.matchAll(FENCED_NAME)) {
        spans.push({ line: index + 1, text, breaking: breaking > 0, fenced: true });
      }
      return;
    }
    if (line.includes(BREAKING_START)) {
      if (breaking > 0)
        problems.push(`${page}:${index + 1}: breaking:start inside a breaking note`);
      breaking = index + 1;
    }
    if (line.includes(BREAKING_END)) {
      if (breaking === 0)
        problems.push(`${page}:${index + 1}: breaking:end without breaking:start`);
      breaking = 0;
    }
    for (const [, text = ""] of line.matchAll(/`([^`]+)`/g)) {
      spans.push({ line: index + 1, text, breaking: breaking > 0, fenced: false });
    }
  });
  if (breaking > 0) problems.push(`${page}:${breaking}: breaking:start is never closed`);
  return spans;
}

/** Lines starting with `prefix` in the block right after `marker`, past blank lines. */
function markedBlock(source: string, marker: string, prefix: string): string[] {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`no ${marker} in ${relative(root, guideFile)}`);
  const lines = source
    .slice(start + marker.length)
    .split("\n")
    .slice(1);
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0 || !lines[first]?.startsWith(prefix)) {
    throw new Error(`no "${prefix}" block right after ${marker} in ${relative(root, guideFile)}`);
  }
  const end = lines.findIndex((line, index) => index > first && !line.startsWith(prefix));
  return lines.slice(first, end < 0 ? undefined : end);
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map(([, value = ""]) => value);
}

const problems: string[] = [];
const usedNonSkills = new Set<string>();

for (const file of walk(contentDir)) {
  const page = relative(root, file);
  for (const { line, text, breaking, fenced } of codeSpans(
    readFileSync(file, "utf8"),
    page,
    problems,
  )) {
    const at = `${page}:${line}`;
    const mate = /^\/?(mate-[a-z0-9-]*)/.exec(text)?.[1];
    if (mate) {
      if (shippedSkills.has(mate) || schemas.has(mate)) continue;
      const listed = [...nonSkills].find((entry) =>
        entry.endsWith("-") ? mate.startsWith(entry) : mate === entry,
      );
      if (listed) {
        usedNonSkills.add(listed);
      } else if (retiredSkills.includes(mate)) {
        if (!breaking) problems.push(`${at}: retired skill \`${mate}\` outside a breaking note`);
      } else if (!fenced) {
        problems.push(`${at}: \`${mate}\` is not a shipped skill, schema, or listed identifier`);
      }
      continue;
    }
    const openspec = /^\/?(openspec-[a-z*-]*)/.exec(text)?.[1];
    const opsx = /^\/opsx(?::([a-z*-]+))?/.exec(text);
    if (!openspec && !opsx) continue;
    const name = openspec ?? opsx?.[0] ?? "";
    if (!breaking) {
      problems.push(`${at}: \`${name}\` outside a breaking note`);
    } else if (openspec && openspec !== "openspec-*" && !openspecSkills.includes(openspec)) {
      problems.push(`${at}: \`${openspec}\` is not an OpenSpec skill Mate removes`);
    } else if (opsx?.[1] && opsx[1] !== "*" && !openspecCommandIds.has(opsx[1])) {
      problems.push(`${at}: \`${name}\` is not an OpenSpec command Mate removes`);
    }
  }
}

const stale = [...nonSkills].filter((entry) => !usedNonSkills.has(entry));
if (stale.length > 0) {
  problems.push(`no page names these listed identifiers, drop them: ${stale.join(", ")}`);
}

const guide = readFileSync(guideFile, "utf8");
const guidePage = relative(root, guideFile);

const renamed = markedBlock(guide, "{/* breaking:renamed */}", "- ").map(backticked);
const renamedOld = renamed.map(([old = ""]) => old);
const missingRenamed = retiredSkills.filter((skill) => !renamedOld.includes(skill));
const extraRenamed = renamedOld.filter((skill) => !retiredSkills.includes(skill));
if (missingRenamed.length > 0 || extraRenamed.length > 0) {
  problems.push(
    `${guidePage}: renamed-skills list names [${renamedOld.join(", ")}] but Mate retires [${retiredSkills.join(", ")}]`,
  );
}
for (const [old = "", replacement = ""] of renamed) {
  if (!shippedSkills.has(replacement)) {
    problems.push(`${guidePage}: \`${old}\` is renamed to \`${replacement}\`, not a shipped skill`);
  }
}

const rows = markedBlock(guide, "{/* breaking:openspec */}", "|")
  .slice(2)
  .map((row) => row.split("|").map((cell) => cell.trim()));
const covered = new Set(rows.flatMap(([, removed = ""]) => backticked(removed)));
for (const skill of openspecSkills) {
  if (!covered.has(skill)) problems.push(`${guidePage}: no replacement row for \`${skill}\``);
}
for (const [, removed = "", use = ""] of rows) {
  const replacement = backticked(use)[0]?.replace(/^\//, "") ?? "";
  if (!shippedSkills.has(replacement)) {
    problems.push(`${guidePage}: row ${removed} maps to \`${use}\`, not a shipped skill`);
  }
}

if (problems.length > 0) {
  console.error(
    `check-docs-names: ${problems.length} name problem(s)\n${problems.map((p) => `  ${p}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `check-docs-names: docs name only shipped skills, and the breaking notes cover ${retiredSkills.length} retired and ${openspecSkills.length} OpenSpec skills`,
);
