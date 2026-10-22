/**
 * Where a heredoc starts, matched at a `<<` outside quotes: an optional `-`,
 * then the terminator word, optionally quoted. Shared by the secret guard's
 * shell tokenizer and the artifact guard's redirect scan, so both agree on
 * what is command text and what is a body.
 */
export const HEREDOC_MARKER = /^<<-?\s*(['"]?)([\w.-]+)\1/;

/** The terminators a command line opens, in order; quoted text is skipped. */
function heredocTerminators(line: string): string[] {
  const terminators: string[] = [];
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') i++;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "\\") {
      i++;
    } else if (char === "<" && line[i + 1] === "<") {
      if (line[i + 2] === "<") {
        i += 2;
        continue;
      }
      const marker = HEREDOC_MARKER.exec(line.slice(i));
      if (marker) {
        terminators.push(marker[2]);
        i += marker[0].length - 1;
      } else {
        i++;
      }
    }
  }
  return terminators;
}

/**
 * The command with every heredoc body and terminator line removed. Marker
 * lines stay: a redirect the command performs is spelled there, never in the
 * body it writes. A heuristic, not a parser, like the tokenizer it mirrors.
 */
export function stripHeredocBodies(command: string): string {
  const kept: string[] = [];
  const pending: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    kept.push(line);
    pending.push(...heredocTerminators(line));
  }
  return kept.join("\n");
}
