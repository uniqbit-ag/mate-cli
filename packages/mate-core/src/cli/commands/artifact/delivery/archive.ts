import { commandOutput } from "./output";
import { runArtifactSubmitCommand, type SubmitCommandDeps } from "./submit";

export const ARCHIVE_DEPRECATION =
  "mate: `artifact archive` is deprecated; use `artifact submit` (skill mate-submit-change). Checking only; nothing is submitted or pushed until `artifact submit` runs.";

/** Appended to a `--json` result's `message`, which skills written for `archive` relay. */
export const ARCHIVE_ALIAS_NOTE =
  "Nothing was archived, submitted or pushed: `mate artifact archive` is deprecated and only recorded the delivery and ran the check; submit with `mate artifact submit` (skill mate-submit-change).";

/** One change's result array as that result alone, its message carrying the alias note. */
function singleResult(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return line;
  const [result] = parsed as [Record<string, unknown>];
  const message = typeof result.message === "string" ? `${result.message}\n` : "";
  return JSON.stringify({ ...result, message: `${message}${ARCHIVE_ALIAS_NOTE}` });
}

/**
 * @command mate artifact archive <change>
 * @description Deprecated alias of `mate artifact submit`: writes a one-line deprecation note to
 * stderr, records the delivery and runs the check with the same flags, and submits nothing:
 * no state changes and nothing is pushed, since the old command never left the machine. Refuses `--drop`. Nothing is archived
 * before the merge. With `--json` and one change it emits that change's result as one object,
 * as `archive` did, its `message` noting the alias.
 */
export async function runArtifactArchiveCommand(
  argv: string[],
  deps: SubmitCommandDeps = {},
): Promise<void> {
  const { emitOut, emitErr, refuse } = commandOutput(deps);
  if (argv.includes("--drop")) {
    return refuse("mate: `artifact archive` takes no --drop; run `mate artifact submit --drop`.");
  }
  emitErr(ARCHIVE_DEPRECATION);
  if (!argv.includes("--json")) return runArtifactSubmitCommand(argv, deps, { holdPush: true });
  const lines: string[] = [];
  await runArtifactSubmitCommand(
    argv,
    { ...deps, stdout: (line) => lines.push(line) },
    { holdPush: true },
  );
  for (const line of lines) emitOut(singleResult(line));
}
