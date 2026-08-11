import { spawn } from "node:child_process";

/** Bounds captured stdout/stderr against a runaway or malicious `openspec` process. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenSpecCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface OpenSpecCliClientOptions {
  executablePath?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** The `openspec` executable could not be spawned at all (not installed, not on PATH, not executable). */
export class OpenSpecCliUnavailableError extends Error {}

/** Resolves `mate.openspecExecutablePath` when set, else the bare command name for PATH lookup by the OS. */
export function resolveOpenSpecExecutable(configuredPath: string | undefined): string {
  const trimmed = configuredPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "openspec";
}

function describeSpawnError(executable: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `openspec executable not found or not runnable ("${executable}"): ${message}`;
}

/**
 * Spawns `<openspec> <args>` with stdout/stderr captured separately and
 * bounded. `openspec` is a second, independent external-CLI boundary
 * alongside {@link runMateCli} — the extension never imports `openspec`'s
 * internals, only its stdout.
 */
export function runOpenSpecCli(
  args: string[],
  options: OpenSpecCliClientOptions = {},
): Promise<OpenSpecCliResult> {
  const executable = resolveOpenSpecExecutable(options.executablePath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new OpenSpecCliUnavailableError(describeSpawnError(executable, error)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`openspec ${args.join(" ")} timed out after ${timeoutMs}ms`));
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
      settle(() => reject(new OpenSpecCliUnavailableError(describeSpawnError(executable, error))));
    });
    child.on("close", (code) => {
      settle(() => resolve({ code, stdout, stderr }));
    });
  });
}
