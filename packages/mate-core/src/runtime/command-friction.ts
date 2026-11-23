import { format } from "node:util";

import type { FrictionRuntime } from "./friction-log";
import { recordCommandFailure, redactCommandOutput } from "./friction-recorder";

interface CommandRun {
  /** Arguments after the executable and script. */
  args: string[];
  /** The agent session the command runs in; without one nothing is captured or recorded. */
  session: { id: string; runtime: FrictionRuntime } | null;
  mateVersion: string;
}

/**
 * Runs a command and prints what it throws. In an agent session a non-zero exit
 * is recorded as friction with the tail of its stderr, and any nudge follows the
 * command's own output. The exit code is the command's.
 */
export async function runRecordingFailure(
  { args, session, mateVersion }: CommandRun,
  run: () => Promise<void>,
): Promise<void> {
  const errors = session
    ? captureErrorTail((text) => redactCommandOutput(text, args, process.env))
    : null;
  const record = (exitCode: number) => {
    if (!session || !errors || exitCode === 0) return;
    try {
      const nudge = recordCommandFailure({
        args,
        exitCode,
        errorText: errors.text(),
        session,
        mateVersion,
        env: process.env,
        cwd: process.cwd(),
      });
      if (nudge) process.stderr.write(`${nudge}\n`);
    } catch {}
  };
  if (session) process.once("exit", record);
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.off("exit", record);
    errors?.restore();
  }
  record(Number(process.exitCode ?? 0));
}

const ERROR_TAIL_LIMIT = 1_000;

function captureErrorTail(redact: (text: string) => string): {
  text(): string;
  restore(): void;
} {
  const originalError = console.error;
  const originalWrite = process.stderr.write;
  let tail = "";
  // Node's console.error writes through process.stderr.write; Bun's does not.
  let inConsoleError = false;
  const append = (piece: () => string) => {
    try {
      tail = `${tail}${redact(piece())}`.slice(-ERROR_TAIL_LIMIT);
    } catch {}
  };
  const error = (...args: unknown[]) => {
    inConsoleError = true;
    try {
      originalError(...args);
    } finally {
      inConsoleError = false;
    }
    append(() => `${format(...args)}\n`);
  };
  const write = ((chunk: unknown, ...rest: unknown[]) => {
    const written = Reflect.apply(originalWrite, process.stderr, [chunk, ...rest]) as boolean;
    if (!inConsoleError) {
      append(() =>
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(),
      );
    }
    return written;
  }) as typeof process.stderr.write;
  console.error = error;
  process.stderr.write = write;
  return {
    text: () => tail,
    restore: () => {
      if (console.error === error) console.error = originalError;
      if (process.stderr.write === write) process.stderr.write = originalWrite;
    },
  };
}
