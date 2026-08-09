import { spawn } from "node:child_process";

/** Bounds captured stdout/stderr against a runaway or malicious `mate` process. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface MateCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface MateCliClientOptions {
  executablePath?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** The `mate` executable could not be spawned at all (not installed, not on PATH, not executable). */
export class MateCliUnavailableError extends Error {}

/** Resolves `mate.executablePath` when set, else the bare command name for PATH lookup by the OS. */
export function resolveMateExecutable(configuredPath: string | undefined): string {
  const trimmed = configuredPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "mate";
}

function describeSpawnError(executable: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Mate executable not found or not runnable ("${executable}"): ${message}`;
}

/**
 * Spawns `<mate> <args>` with stdout/stderr captured separately and bounded.
 * The extension's only backend boundary — never imports `@uniqbit/mate-core`
 * and never reads `~/.mate` or `.mate/config` directly.
 */
export function runMateCli(
  args: string[],
  options: MateCliClientOptions = {},
): Promise<MateCliResult> {
  const executable = resolveMateExecutable(options.executablePath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new MateCliUnavailableError(describeSpawnError(executable, error)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`mate ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle(() => reject(new MateCliUnavailableError(describeSpawnError(executable, error))));
    });
    child.on("close", (code) => {
      settle(() => resolve({ code, stdout, stderr }));
    });
  });
}
