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
import { joinLines, scanLines, type ScannedLine } from "./markdown-scan";

/**
 * Companion Instructions: the companion's own `AGENTS.md`, rendered for one
 * Agent Runtime and one session. Read-only and runtime-neutral, so the launch
 * adapter and the session hooks deliver the same text.
 *
 * Claude Code loads no memory from a directory granted through settings, so a
 * Working Repository session gets these only when Mate inlines them. The text
 * mirrors what native loading of the companion `CLAUDE.md` (`@AGENTS.md`)
 * yields: block-level HTML comments stripped, `AGENTS.override.md` not read. `@` lines stay
 * literal, because expanding an import outside the project needs an approval a
 * hook or `-p` session never gets.
 */

export const COMPANION_INSTRUCTIONS_TAG = "companion-instructions";

/**
 * Below Claude Code's 10,000-character cap on one hook's `additionalContext`;
 * a longer value arrives as a file preview instead of in context.
 */
export const COMPANION_INSTRUCTIONS_BUDGET = 9_000;

export type InstructionRuntime = "claude" | "opencode";

/** The companion file each runtime's surface writes its `mate:managed` blocks to. */
const BLOCK_FILE: Record<InstructionRuntime, string> = {
  claude: "CLAUDE.md",
  opencode: "AGENTS.md",
};

export interface CompanionInstructionsInput {
  companionPath: string;
  repository: { id: string; path: string };
  wrapperBinPath: string;
  runtime: InstructionRuntime;
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

function tidy(text: string): string {
  return joinLines(scanLines(text));
}

interface Segment {
  /** The `##` heading, or a description for text no heading introduces. */
  name: string;
  text: string;
  /** The `MATE:COMPANION` block: always kept whole. */
  required: boolean;
  source: string;
}

const UNTITLED = "text before the first section";

function splitSections(text: string, source: string): Segment[] {
  const sections: { name: string; lines: ScannedLine[] }[] = [{ name: UNTITLED, lines: [] }];
  for (const line of scanLines(text)) {
    if (line.heading !== null) sections.push({ name: line.heading, lines: [] });
    sections.at(-1)!.lines.push(line);
  }
  return sections.map(({ name, lines }) => ({
    name,
    text: joinLines(lines),
    required: false,
    source,
  }));
}

/** The block's markers are found before the scan, which would strip them as comments. */
function segmentAgents(text: string, source: string): Segment[] {
  const { start, end } = companionBlockMarkers(FRAMEWORK_NAME);
  const startIndex = text.indexOf(start);
  const endIndex = startIndex === -1 ? -1 : text.indexOf(end, startIndex);

  const parts: Segment[] =
    endIndex === -1
      ? splitSections(text, source)
      : [
          ...splitSections(text.slice(0, startIndex), source),
          {
            name: `${FRAMEWORK_NAME.toUpperCase()}:COMPANION block`,
            text: tidy(text.slice(startIndex, endIndex + end.length)),
            required: true,
            source,
          },
          ...splitSections(text.slice(endIndex + end.length), source),
        ];
  return parts.filter((part) => part.text.length > 0);
}

function segmentBlocks(
  blocks: readonly ManagedBlock[],
  source: string,
  input: CompanionInstructionsInput,
): Segment[] {
  return blocks
    .map((block) => ({
      name: `${path.basename(source)} block ${managedBlockPluginId(block.key)}`,
      text: tidy(fillPlaceholders(block.body, input)),
      required: false,
      source,
    }))
    .filter((part) => part.text.length > 0);
}

/** A block marker names no runtime; the file it sits in does. */
function segment(
  agents: string,
  source: string,
  input: CompanionInstructionsInput,
  deps: CompanionInstructionsDeps,
): Segment[] {
  const blockFile = BLOCK_FILE[input.runtime];
  if (blockFile === "AGENTS.md") return segmentAgents(fillPlaceholders(agents, input), source);

  const own = stripManagedBlocks(agents, FRAMEWORK_NAME);
  const blockSource = path.join(input.companionPath, blockFile);
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
function omissionReserve(optional: readonly Segment[], source: string): number {
  const listed = optional.map((part) => omissionName(part.name)).join(", ").length;
  const more = listed > OMISSION_NAMES_CAP ? ` and ${optional.length} more`.length : 0;
  const fixed = omissionLine("", fullTextSources(source, optional)).length;
  return fixed + Math.min(listed, OMISSION_NAMES_CAP) + more;
}

/** The omission line's worst case is reserved before any segment is added, so adding the real line never pushes a fitting result over. */
function fit(
  source: string,
  segments: readonly Segment[],
): { text: string; omitted: string[]; oversized: boolean } {
  const whole = render(source, segments);
  if (whole.length <= COMPANION_INSTRUCTIONS_BUDGET) {
    return { text: whole, omitted: [], oversized: false };
  }

  const optional = segments.filter((part) => !part.required);
  const reserve = "#".repeat(omissionReserve(optional, source));
  const kept = new Set<Segment>(segments.filter((part) => part.required));
  let length = render(source, [...kept], reserve).length;
  for (const part of optional) {
    const next = length + part.text.length + "\n\n".length;
    if (next > COMPANION_INSTRUCTIONS_BUDGET) continue;
    kept.add(part);
    length = next;
  }

  const chosen = segments.filter((part) => kept.has(part));
  const omitted = optional.filter((part) => !kept.has(part));
  const body = render(source, chosen);
  const closing =
    omitted.length > 0
      ? closingLine(
          omitted.map((part) => part.name),
          fullTextSources(source, omitted),
          COMPANION_INSTRUCTIONS_BUDGET - body.length - "\n\n".length,
        )
      : undefined;
  const text = render(source, chosen, closing);
  return {
    text,
    omitted: omitted.map((part) => part.name),
    oversized: text.length > COMPANION_INSTRUCTIONS_BUDGET,
  };
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
  return scanLines(stripManagedBlocks(read.text, FRAMEWORK_NAME)).some((line) => {
    const trimmed = line.text.trim();
    return trimmed !== "" && trimmed !== "@AGENTS.md" && trimmed !== "@./AGENTS.md";
  });
}
