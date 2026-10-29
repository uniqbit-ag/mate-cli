import path from "node:path";

import { heredocBodies, readShell, type ShellCommand, type ShellWord } from "./shell-reading";

const CO_AUTHOR_TRAILER = /^\s*co-authored-by\s*[:=]\s*(.+)$/gim;
/** Substrings, not words: `ChatGPT` and `claude_bot` mention a model too. */
const MODEL_NAME = /claude|anthropic|gpt|openai|codex|gemini|copilot|opencode/i;

/** `git` options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
/** `git commit` short options whose value is the next word, or the rest of the cluster. */
const COMMIT_VALUE_SHORTS = new Set(["m", "F", "t", "c", "C"]);

/**
 * The words after `git commit`, once for each place `git` may stand: the
 * name or, when the name's position holds a substitution, which may expand
 * to nothing, a path or a wrapper, that word and every later one.
 */
function commitArguments(argv: ShellWord[]): ShellWord[][] {
  const places = argv[0]?.opaque ? argv.length : Math.min(argv.length, 1);
  const found: ShellWord[][] = [];
  for (let i = 0; i < places; i++) {
    const args = mayNameGit(argv[i]) ? afterGitCommit(argv, i + 1) : null;
    if (args) found.push(args);
  }
  return found;
}

const isGit = (name: string) => path.basename(name) === "git";

/**
 * Whether the word may run `git`: by its text or, holding a substitution, by
 * its literal parts with the substitutions empty (`$(true)git`) or by the
 * literal part it ends with (`$(echo /usr/bin/)git`).
 */
function mayNameGit(word: ShellWord): boolean {
  if (!word.opaque) return isGit(word.text);
  const last = word.pieces.at(-1);
  return (
    isGit(word.pieces.join("")) || (last !== undefined && word.text.endsWith(last) && isGit(last))
  );
}

/** The words after `commit`, past git's own options; a substitution among them may be one or nothing. */
function afterGitCommit(argv: ShellWord[], start: number): ShellWord[] | null {
  let i = start;
  while (i < argv.length && (argv[i].opaque || argv[i].text.startsWith("-"))) {
    i += !argv[i].opaque && GIT_VALUE_OPTIONS.has(argv[i].text) ? 2 : 1;
  }
  return argv[i]?.text === "commit" ? argv.slice(i + 1) : null;
}

/**
 * Message text the arguments carry: `-m x`, `-mx`, `-am x`, `--message=x` and
 * `--message x` values, plus each `--trailer` value as a trailer line.
 */
function messageValues(args: ShellWord[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const text = arg.text;
    if (text === "--") break;
    if (text === "--message" || text === "--trailer") {
      if (i + 1 < args.length) values.push(args[++i].text);
    } else if (text.startsWith("--message=") || text.startsWith("--trailer=")) {
      values.push(text.slice(text.indexOf("=") + 1));
    } else if (/^-[^-]/.test(text)) {
      for (let j = 1; j < text.length; j++) {
        if (!COMMIT_VALUE_SHORTS.has(text[j])) continue;
        const rest = text.slice(j + 1);
        const value = rest || args[++i]?.text;
        if (text[j] === "m" && value !== undefined) values.push(value);
        break;
      }
    }
  }
  return values;
}

/** Whether a trailer credits a model; a literal `\n`, as `printf` or `$'…'` expand it, counts as a line break. */
function creditsModel(text: string): boolean {
  for (const trailer of text.replace(/\\n/g, "\n").matchAll(CO_AUTHOR_TRAILER)) {
    if (MODEL_NAME.test(trailer[1])) return true;
  }
  return false;
}

const REFUSAL = [
  "Mate guardrail: Co-Authored-By trailers that credit an AI model are not allowed in this repository.",
  "No commit was created. Rerun the same commit without the Co-Authored-By trailer; do not amend or rewrite history to remove it.",
].join("\n");

/**
 * The message text a commit's own words carry: its message values, a
 * here-string's text, and what the substitutions in its arguments and redirect
 * targets run (`-F <(cat <<EOF …)`, `< <(…)`), their arguments and heredocs.
 */
function commitTexts(command: ShellCommand, commits: ShellWord[][]): string[] {
  const carriers = [...commits.flat(), ...command.redirects.map((redirect) => redirect.target)];
  const inner = carriers.flatMap((word) => word.commands);
  return [
    ...commits.flatMap(messageValues),
    ...command.redirects
      .filter((redirect) => redirect.operator === "<<<")
      .map((redirect) => redirect.target.text),
    ...inner.flatMap((substituted) => substituted.argv.map((word) => word.text)),
    ...heredocBodies(inner),
  ];
}

/**
 * Returns the refusal for a shell command running `git commit` whose message
 * credits an AI model as co-author, or null. Finds every commit the shell
 * reader finds, behind wrappers and inside substitutions too. Reads only
 * message text in the command: `-m`/`--message`/`--trailer` values, a
 * here-string, what the substitutions in the commit's arguments and redirects
 * carry, and the heredoc bodies the commit reads, its own, piped in or reaching
 * a group it runs in. `-F <file>`, `-t` and editor messages pass unchecked.
 * Throws `ShellNestingError` for a command nested too deeply to read.
 */
export function checkCommitAttribution(command: string): string | null {
  const commits = readShell(command)
    .commands.map((found) => ({ found, args: commitArguments(found.argv) }))
    .filter(({ args }) => args.length > 0);
  const texts = [
    ...commits.flatMap(({ found, args }) => commitTexts(found, args)),
    ...heredocBodies(commits.map(({ found }) => found)),
  ];
  return texts.some(creditsModel) ? REFUSAL : null;
}
