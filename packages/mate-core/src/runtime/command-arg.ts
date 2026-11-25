/**
 * Quotes one argument of a command a person pastes into a shell. Plain words stay bare and double
 * quotes are used where cmd.exe, PowerShell and POSIX shells all keep the text unchanged; any
 * other text falls back to POSIX single quotes.
 */
export function quoteCommandArg(value: string): string {
  if (/^[\w:./+=-]+$/.test(value)) return value;
  if (!/["$`\\!%]/.test(value)) return `"${value}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** One command line from its words, each quoted with `quoteCommandArg`. */
export function formatCommand(words: string[]): string {
  return words.map(quoteCommandArg).join(" ");
}
