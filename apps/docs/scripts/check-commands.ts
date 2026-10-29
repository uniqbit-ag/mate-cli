/**
 * Docs hygiene check: every command in the CLI's `usage()` "Commands:" block must
 * appear in the command reference, inline as `` `mate <command>`` ` or at the start of a
 * code-block line, and every such `mate <words>` on any page must name a usage command,
 * a group of them, or a command followed by arguments it accepts. Parses the source text instead of
 * importing it, so the check needs no Mate distribution setup.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { walk } from "./lib.ts";

const root = join(import.meta.dir, "..");
const usageFile = join(root, "..", "..", "packages", "mate-core", "src", "cli", "usage.ts");
const contentDir = join(root, "content", "docs");
const referenceFile = join(contentDir, "reference", "commands.mdx");

/** Alpha features kept out of the docs on purpose. Remove an entry when its docs ship. */
const undocumented = new Set([
  "companion register",
  "companion prepare",
  "hub init",
  "hub add",
  "hub sync",
  "plugin install",
  "report",
  "studio",
  "studio serve",
]);

interface UsageCommand {
  command: string;
  /** Takes positional arguments, so further words after the command are allowed. */
  positional: boolean;
}

/** Whether a usage line's text after the command words names a positional argument. */
function hasPositional(rest: string): boolean {
  let text = rest.replace(/\(.*\)/g, "");
  // Drop innermost optional flag groups until none remain, e.g. `[--branch <b> [--direct]]`.
  for (let prev = ""; prev !== text;) {
    prev = text;
    text = text.replace(/\[--[^[\]]*\]/g, "");
  }
  text = text.replace(/--\S+(?: <[^>]+>)?/g, "");
  return /[<[]/.test(text);
}

/** Each `${n} ...` line: command words up to the first argument or flag. */
function usageCommands(source: string): UsageCommand[] {
  const start = source.indexOf('"Commands:"');
  const end = source.indexOf('"",', start);
  if (start < 0 || end < 0) throw new Error(`no "Commands:" block in ${usageFile}`);
  const block = source.slice(start, end);
  const byCommand = new Map<string, boolean>();
  for (const [, command = "", rest = ""] of block.matchAll(
    /` \$\{n\} ([a-z][a-z-]*(?: [a-z][a-z-]*)*)([^`]*)`/g,
  )) {
    byCommand.set(command, (byCommand.get(command) ?? false) || hasPositional(rest));
  }
  return [...byCommand].map(([command, positional]) => ({ command, positional }));
}

/** Accepted but kept out of `usage()`. Remove an entry when the command is gone. */
const unlisted = new Set(["artifact finish"]);

/**
 * `mate <words>` references with page line numbers: inline code starting with `mate`, and
 * any `mate` word in a code-block line (after `$`, `&&`, `bunx`, ...). `text` fences hold
 * sample output, such as `mate guardrail:` messages, and are skipped.
 */
function pageCommands(source: string): { line: number; words: string }[] {
  const found: { line: number; words: string }[] = [];
  let fence: string | null = null;
  source.split("\n").forEach((line, index) => {
    const opener = /^\s*```(\S*)/.exec(line);
    if (opener) {
      fence = fence === null ? (opener[1] ?? "") : null;
      return;
    }
    if (fence === "text") return;
    const texts = fence !== null ? [line] : [...line.matchAll(/`([^`]+)`/g)].map(([, t = ""]) => t);
    const pattern =
      fence !== null ? /(?<![\w./@-])mate((?: [a-z][a-z-]*)+)/g : /^mate((?: [a-z][a-z-]*)+)/g;
    for (const text of texts) {
      for (const [, words = ""] of text.matchAll(pattern)) {
        found.push({ line: index + 1, words: words.trim() });
      }
    }
  });
  return found;
}

/**
 * `words` names `command` when it is the command, a group prefix of it, or the command
 * followed by arguments the command takes.
 */
function names(words: string, { command, positional }: UsageCommand): boolean {
  return (
    words === command ||
    command.startsWith(`${words} `) ||
    (positional && words.startsWith(`${command} `))
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const usage = usageCommands(readFileSync(usageFile, "utf8"));
const commands = usage.map(({ command }) => command);
const reference = readFileSync(referenceFile, "utf8");

// Unlisted commands are not in usage, so their arguments are not known: allow any.
const known = [...usage, ...[...unlisted].map((command) => ({ command, positional: true }))];
const references = walk(contentDir).flatMap((file) =>
  pageCommands(readFileSync(file, "utf8")).map((ref) => ({ ...ref, page: relative(root, file) })),
);
const unknown = references
  .filter(({ words }) => !known.some((command) => names(words, command)))
  .map(({ page, line, words }) => `  ${page}:${line}: mate ${words}`);
const usedUnlisted = new Set(
  [...unlisted].filter((command) =>
    references.some(({ words }) => names(words, { command, positional: true })),
  ),
);
const staleUnlisted = [...unlisted].filter(
  (command) => commands.includes(command) || !usedUnlisted.has(command),
);

const stale = [...undocumented].filter((command) => !commands.includes(command));
if (stale.length > 0) {
  console.error(
    `check-commands: no longer CLI commands, drop them from the undocumented list: ${stale.join(", ")}`,
  );
  process.exit(1);
}

if (staleUnlisted.length > 0) {
  console.error(
    `check-commands: drop from the unlisted list (now in usage, or named by no page): ${staleUnlisted.join(", ")}`,
  );
  process.exit(1);
}
if (unknown.length > 0) {
  console.error(
    `check-commands: ${unknown.length} docs reference(s) name no CLI command\n${unknown.join("\n")}`,
  );
  process.exit(1);
}

const missing = commands.filter(
  (command) =>
    !undocumented.has(command) &&
    !new RegExp(`(?:\`|^)mate ${escapeRegExp(command)}(?![a-z-])`, "m").test(reference),
);
if (missing.length > 0) {
  console.error(
    `check-commands: ${missing.length} command(s) missing from ${relative(root, referenceFile)}\n${missing.map((command) => `  mate ${command}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `check-commands: all ${commands.length - undocumented.size} documented CLI commands are in the command reference (${undocumented.size} alpha commands left out)`,
);
