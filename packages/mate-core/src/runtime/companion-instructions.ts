import fs from "node:fs";
import path from "node:path";

import { MATE_ENV } from "./env-names";
import { FRAMEWORK_NAME } from "./framework";
import {
  companionBlockMarkers,
  findManagedBlocks,
  managedBlockPluginId,
  stripManagedBlocks,
  type ManagedBlock,
} from "./managed-block";
import { joinLines, scanLinesWithoutComments, type ScannedLine } from "./markdown-scan";

/**
 * Companion Instructions: the companion's own `AGENTS.md`, rendered for one
 * Claude session. Read-only. The text mirrors what native loading of the
 * companion `CLAUDE.md` (`@AGENTS.md`) yields: block-level HTML comments
 * stripped, `AGENTS.override.md` not read. `@` lines stay literal, because
 * expanding an import outside the project needs an approval a hook or `-p`
 * session never gets.
 */

export const COMPANION_INSTRUCTIONS_TAG = "companion-instructions";

/**
 * Below Claude Code's 10,000-character cap on one hook's `additionalContext`;
 * a longer value arrives as a file preview instead of in context.
 */
export const COMPANION_INSTRUCTIONS_BUDGET = 9_000;

/** Where the Claude Runtime Surface writes its `mate:managed` blocks; those in `AGENTS.md` are OpenCode's. */
const CLAUDE_BLOCK_FILE = "CLAUDE.md";

export interface CompanionInstructionsInput {
  companionPath: string;
  repository: { id: string; path: string };
  wrapperBinPath: string;
}

export type CompanionInstructions =
  | {
      kind: "available";
      /** Absolute path of the companion `AGENTS.md`. */
      source: string;
      text: string;
      omitted: string[];
      /** The `MATE:COMPANION` block alone overruns the budget; it is never cut, so every other segment is omitted. */
      oversized: boolean;
    }
  | { kind: "unavailable"; source: string; reason: string };

export type InstructionReader = (input: CompanionInstructionsInput) => CompanionInstructions;

export function companionInstructionsUnavailableLine(
  result: Extract<CompanionInstructions, { kind: "unavailable" }>,
): string {
  return `Companion instructions unavailable: ${result.source} ${result.reason}`;
}

export interface CompanionInstructionsDeps {
  isFile?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
}

function defaultIsFile(filePath: string): boolean {
  return fs.statSync(filePath).isFile();
}

function defaultReadFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

/** Only a regular file is opened: a FIFO would block the read, and a hook that never returns stalls the session. */
function readText(
  filePath: string,
  deps: CompanionInstructionsDeps,
): { text: string } | { reason: string } {
  const isFile = deps.isFile ?? defaultIsFile;
  const readFile = deps.readFile ?? defaultReadFile;
  try {
    if (!isFile(filePath)) return { reason: "is not a regular file" };
    return { text: readFile(filePath).replace(/\r\n?/g, "\n") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { reason: "not found" };
    return { reason: `could not be read (${code ?? (error as Error).message})` };
  }
}

function fillPlaceholders(text: string, input: CompanionInstructionsInput): string {
  const values: Record<string, string> = {
    [MATE_ENV.repositoryPath]: input.repository.path,
    [MATE_ENV.repositoryId]: input.repository.id,
    [MATE_ENV.companionPath]: input.companionPath,
    [MATE_ENV.wrapperBinPath]: input.wrapperBinPath,
  };
  return text.replace(
    /\$\{(MATE_\w+)\}|\$(MATE_\w+)/g,
    (match, braced?: string, bare?: string) => values[(braced ?? bare)!] ?? match,
  );
}

interface Segment {
  /** The `##` heading, or a description for text no heading introduces. */
  name: string;
  text: string;
  /** The `MATE:COMPANION` block: always kept whole. */
  required: boolean;
  source: string;
  /** Shared by the two halves of a section the block sits in, so they are kept or omitted together. */
  section: object;
}

const UNTITLED = "text before the first section";

function splitSections(text: string, source: string): Segment[] {
  const sections: { name: string; lines: ScannedLine[] }[] = [{ name: UNTITLED, lines: [] }];
  for (const line of scanLinesWithoutComments(text)) {
    if (line.heading !== null) sections.push({ name: line.heading, lines: [] });
    sections.at(-1)!.lines.push(line);
  }
  return sections.map(({ name, lines }) => ({
    name,
    text: joinLines(lines),
    required: false,
    source,
    section: {},
  }));
}

/** The block's markers are found before the scan, which would strip them as comments. */
function segmentAgents(text: string, source: string): Segment[] {
  const { start, end } = companionBlockMarkers(FRAMEWORK_NAME);
  const startIndex = text.indexOf(start);
  const endIndex = startIndex === -1 ? -1 : text.indexOf(end, startIndex);
  if (endIndex === -1) return splitSections(text, source).filter((part) => part.text.length > 0);

  const before = splitSections(text.slice(0, startIndex), source);
  const after = splitSections(text.slice(endIndex + end.length), source);
  /** The text after the block, up to the next heading, continues the section the block opened in. */
  const enclosing = before.at(-1)!;
  after[0] = { ...after[0]!, name: enclosing.name, section: enclosing.section };
  const block: Segment = {
    name: `${FRAMEWORK_NAME.toUpperCase()}:COMPANION block`,
    text: joinLines(scanLinesWithoutComments(text.slice(startIndex, endIndex + end.length))),
    required: true,
    source,
    section: {},
  };
  return [...before, block, ...after].filter((part) => part.text.length > 0);
}

function segmentBlocks(
  blocks: readonly ManagedBlock[],
  source: string,
  input: CompanionInstructionsInput,
): Segment[] {
  return blocks
    .map((block) => ({
      name: `${path.basename(source)} block ${managedBlockPluginId(block.key)}`,
      text: joinLines(scanLinesWithoutComments(fillPlaceholders(block.body, input))),
      required: false,
      source,
      section: {},
    }))
    .filter((part) => part.text.length > 0);
}

function segment(
  agents: string,
  source: string,
  input: CompanionInstructionsInput,
  deps: CompanionInstructionsDeps,
): Segment[] {
  const own = stripManagedBlocks(agents, FRAMEWORK_NAME);
  const blockSource = path.join(input.companionPath, CLAUDE_BLOCK_FILE);
  const read = readText(blockSource, deps);
  const blocks = "text" in read ? findManagedBlocks(read.text, FRAMEWORK_NAME) : [];
  return [
    ...segmentAgents(fillPlaceholders(own, input), source),
    ...segmentBlocks(blocks, blockSource, input),
  ];
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function render(source: string, segments: readonly Segment[], closing?: string): string {
  const body = [...segments.map((part) => part.text), ...(closing ? [closing] : [])].join("\n\n");
  return `<${COMPANION_INSTRUCTIONS_TAG} source="${escapeAttribute(source)}">\n${body}\n</${COMPANION_INSTRUCTIONS_TAG}>`;
}

/** Hundreds of headings would otherwise make the omission line alone exceed the budget. */
const OMISSION_NAMES_CAP = 400;
const OMISSION_NAME_MAX = 80;

/** Cut by code point, so a heading of astral characters never ends in half a surrogate pair. */
function omissionName(name: string): string {
  const points = [...name];
  if (points.length <= OMISSION_NAME_MAX) return name;
  return `${points.slice(0, OMISSION_NAME_MAX - 1).join("")}…`;
}

function listOmitted(names: readonly string[], cap: number): string {
  const shown: string[] = [];
  for (const name of names.map(omissionName)) {
    const listing = [...shown, name].join(", ");
    if (shown.length > 0 && listing.length > cap) break;
    shown.push(name);
  }
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function omissionLine(listing: string, sources: readonly string[]): string {
  return `Sections not included here: ${listing}. Full text: ${sources.join(" and ")}`;
}

/** Capped at `room` too: a block that leaves little room gets a count, not a listing that carries the result past Claude Code's hook cap. */
function closingLine(names: readonly string[], sources: readonly string[], room: number): string {
  const fixed = omissionLine("", sources).length + ` and ${names.length} more`.length;
  return omissionLine(listOmitted(names, Math.min(OMISSION_NAMES_CAP, room - fixed)), sources);
}

function fullTextSources(source: string, parts: readonly Segment[]): string[] {
  const others = new Set(parts.map((part) => part.source).filter((file) => file !== source));
  return [source, ...others];
}

/**
 * The longest omission line any subset of `optional` can produce. A subset
 * lists at most the capped names, and its count of unlisted names, which only
 * appears once the full listing passes the cap, has at most as many digits as
 * the whole.
 */
function omissionReserve(sections: readonly Segment[][], source: string): number {
  const listed = sections.map((parts) => omissionName(parts[0]!.name)).join(", ").length;
  const more = listed > OMISSION_NAMES_CAP ? ` and ${sections.length} more`.length : 0;
  const fixed = omissionLine("", fullTextSources(source, sections.flat())).length;
  return fixed + Math.min(listed, OMISSION_NAMES_CAP) + more;
}

/** The segments other than the block, grouped by section in document order. */
function optionalSections(segments: readonly Segment[]): Segment[][] {
  const sections = new Map<object, Segment[]>();
  for (const part of segments) {
    if (part.required) continue;
    const parts = sections.get(part.section);
    if (parts) parts.push(part);
    else sections.set(part.section, [part]);
  }
  return [...sections.values()];
}

/** The omission line's worst case is reserved before any section is added, so adding the real line never pushes a fitting result over. */
function fit(
  source: string,
  segments: readonly Segment[],
): { text: string; omitted: string[]; oversized: boolean } {
  const whole = render(source, segments);
  if (whole.length <= COMPANION_INSTRUCTIONS_BUDGET) {
    return { text: whole, omitted: [], oversized: false };
  }

  const sections = optionalSections(segments);
  const reserve = "#".repeat(omissionReserve(sections, source));
  const kept = new Set<Segment>(segments.filter((part) => part.required));
  let length = render(source, [...kept], reserve).length;
  for (const parts of sections) {
    const next = parts.reduce((sum, part) => sum + part.text.length + "\n\n".length, length);
    if (next > COMPANION_INSTRUCTIONS_BUDGET) continue;
    for (const part of parts) kept.add(part);
    length = next;
  }

  const chosen = segments.filter((part) => kept.has(part));
  const omitted = sections.filter((parts) => !kept.has(parts[0]!));
  const names = omitted.map((parts) => parts[0]!.name);
  const body = render(source, chosen);
  const closing =
    omitted.length > 0
      ? closingLine(
          names,
          fullTextSources(source, omitted.flat()),
          COMPANION_INSTRUCTIONS_BUDGET - body.length - "\n\n".length,
        )
      : undefined;
  const text = render(source, chosen, closing);
  return { text, omitted: names, oversized: text.length > COMPANION_INSTRUCTIONS_BUDGET };
}

export function buildCompanionInstructions(
  input: CompanionInstructionsInput,
  deps: CompanionInstructionsDeps = {},
): CompanionInstructions {
  const source = path.join(input.companionPath, "AGENTS.md");
  const read = readText(source, deps);
  if (!("text" in read)) return { kind: "unavailable", source, reason: read.reason };

  return { kind: "available", source, ...fit(source, segment(read.text, source, input, deps)) };
}

/**
 * Text beyond the `@AGENTS.md` import, Mate-managed blocks and HTML comments:
 * only a companion-scoped session reads it; the Companion Instructions leave it out.
 */
export function companionClaudeMdHasOwnText(
  companionPath: string,
  deps: CompanionInstructionsDeps = {},
): boolean {
  const read = readText(path.join(companionPath, "CLAUDE.md"), deps);
  if (!("text" in read)) return false;
  return scanLinesWithoutComments(stripManagedBlocks(read.text, FRAMEWORK_NAME)).some((line) => {
    const trimmed = line.text.trim();
    return trimmed !== "" && trimmed !== "@AGENTS.md" && trimmed !== "@./AGENTS.md";
  });
}
