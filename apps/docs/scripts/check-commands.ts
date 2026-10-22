/**
 * Docs hygiene check: every command in the CLI's `usage()` "Commands:" block must
 * appear in the command reference, inline as `` `mate <command>`` ` or at the start of a
 * code-block line. Parses the source text instead of importing it, so the check needs
 * no Mate distribution setup.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const usageFile = join(root, "..", "..", "packages", "mate-core", "src", "cli", "usage.ts");
const referenceFile = join(root, "content", "docs", "reference", "commands.mdx");

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

/** Command words of each `${n} ...` line, stopping at the first argument or flag. */
function usageCommands(source: string): string[] {
  const start = source.indexOf('"Commands:"');
  const end = source.indexOf('"",', start);
  if (start < 0 || end < 0) throw new Error(`no "Commands:" block in ${usageFile}`);
  const block = source.slice(start, end);
  const commands = [...block.matchAll(/` \$\{n\} ([a-z][a-z-]*(?: [a-z][a-z-]*)*)/g)].map(
    ([, command = ""]) => command,
  );
  return [...new Set(commands)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const commands = usageCommands(readFileSync(usageFile, "utf8"));
const reference = readFileSync(referenceFile, "utf8");

const stale = [...undocumented].filter((command) => !commands.includes(command));
if (stale.length > 0) {
  console.error(
    `check-commands: no longer CLI commands, drop them from the undocumented list: ${stale.join(", ")}`,
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
