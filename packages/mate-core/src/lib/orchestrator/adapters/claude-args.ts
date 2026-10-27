/** Reads the operator's `claude` arguments as tokens, for where Mate's appended prompt goes. */

export const APPEND_PROMPT_FLAG = "--append-system-prompt";
export const SNAPSHOT_FLAG = "--system-prompt-snapshot";
const RESUME_FLAGS = new Set(["--resume", "--continue", "--from-pr", "--teleport"]);
/** The main command's short flags that take a value: Claude reads the rest of a cluster as that value, so `-dc` is a debug filter. */
const VALUE_SHORT_FLAGS = new Set(["d", "n", "w"]);

function flagArgs(args: readonly string[]): readonly string[] {
  const terminator = args.indexOf("--");
  return terminator === -1 ? args : args.slice(0, terminator);
}

function shortFlagsResume(arg: string): boolean {
  if (!/^-[A-Za-z]/.test(arg)) return false;
  for (const letter of arg.slice(1)) {
    if (letter === "r" || letter === "c") return true;
    if (VALUE_SHORT_FLAGS.has(letter) || !/^[A-Za-z]$/.test(letter)) return false;
  }
  return false;
}

function resumesConversation(flags: readonly string[]): boolean {
  return flags.some((arg) =>
    arg.startsWith("--") ? RESUME_FLAGS.has(arg.split("=")[0]!) : shortFlagsResume(arg),
  );
}

function setsSnapshotMode(flags: readonly string[]): boolean {
  return flags.some((arg) => arg === SNAPSHOT_FLAG || arg.startsWith(`${SNAPSHOT_FLAG}=`));
}

/** A resumed or continued conversation that leaves the snapshot mode to Mate. */
export function needsSnapshotOff(flags: readonly string[]): boolean {
  return resumesConversation(flags) && !setsSnapshotMode(flags);
}

/**
 * The operator's own `--append-system-prompt` values, lifted out of `args`:
 * Claude keeps only the last such flag, so each would replace the policy and
 * the instructions instead of following them. A trailing flag without a value
 * stays, for Claude to reject. `boundary` is where a lifted flag stood before
 * an argument that is no flag: a variadic option such as `--add-dir` before
 * it would otherwise read that argument as its own value, so Mate's flag goes
 * there. Only the first such place is kept: Claude reads one prompt.
 */
export function liftAppendedPrompts(args: readonly string[]): {
  args: string[];
  flags: string[];
  prompts: string[];
  boundary?: number;
} {
  const flags = flagArgs(args);
  const kept: string[] = [];
  const prompts: string[] = [];
  const liftedAt: number[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    const arg = flags[index]!;
    if (arg === APPEND_PROMPT_FLAG && index + 1 < flags.length) {
      prompts.push(flags[index + 1]!);
      liftedAt.push(kept.length);
      index += 1;
    } else if (arg.startsWith(`${APPEND_PROMPT_FLAG}=`)) {
      prompts.push(arg.slice(APPEND_PROMPT_FLAG.length + 1));
      liftedAt.push(kept.length);
    } else {
      kept.push(arg);
    }
  }
  const passthrough = [...kept, ...args.slice(flags.length)];
  const boundary = liftedAt.find(
    (at) => at > 0 && at < passthrough.length && !passthrough[at]!.startsWith("-"),
  );
  return {
    args: passthrough,
    flags: kept,
    prompts,
    ...(boundary === undefined ? {} : { boundary }),
  };
}
