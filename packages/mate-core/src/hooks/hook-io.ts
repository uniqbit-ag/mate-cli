/** Stdin and stdout of a Claude hook shim. */

export type HookEnv = Record<string, string | undefined>;

/** One run of a hook shim: its environment, directory, shim arguments and stdin payload. */
export interface HookCall {
  env: HookEnv;
  cwd: string;
  argv: readonly string[];
  input: unknown;
}

export interface HookOutcome {
  exitCode: number;
  stdout: string;
}

/** A hook's JSON output line, or nothing. Always exit zero: a hook must never block the session. */
export function hookOutcome(output: object | null): HookOutcome {
  return { exitCode: 0, stdout: output ? `${JSON.stringify(output)}\n` : "" };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** The hook payload on stdin; input that is not JSON reads as `null`, no event. */
async function readHookInput(): Promise<unknown> {
  const raw = await readStdin();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * A hook shim's whole run: read the payload, build the outcome, write it.
 * `onError` turns a failure in either step into an outcome, so the shim still exits zero.
 */
export async function runHook(
  build: (input: unknown) => HookOutcome | Promise<HookOutcome>,
  onError: (error: unknown) => HookOutcome,
): Promise<number> {
  let outcome: HookOutcome;
  try {
    outcome = await build(await readHookInput());
  } catch (error) {
    outcome = onError(error);
  }
  writeHookStdout(outcome.stdout);
  return outcome.exitCode;
}

/** Swallows stdout errors: a parent that stopped reading would otherwise end the write in an uncaught `EPIPE`. */
function writeHookStdout(stdout: string): void {
  if (!stdout) return;
  process.stdout.on("error", () => {});
  process.stdout.write(stdout);
}
