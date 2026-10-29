import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Set on every `openspec` process Mate starts. Mate decides the CLI version, so
 * OpenSpec's own "update available" hint is wrong advice here.
 */
export const OPENSPEC_ENV = {
  OPENSPEC_TELEMETRY: "0",
  OPENSPEC_NO_UPDATE_CHECK: "1",
} as const satisfies Record<string, string>;

/** The bundled CLI, with its version when its manifest is readable, or the reinstall message. */
export type OpenSpecLocation = { bin: string; version?: string } | { missing: string };

export interface OpenSpecRunOptions {
  cwd: string;
  /** `capture` (default) collects output; `inherit` streams it to the terminal. */
  stdio?: "capture" | "inherit";
  /** Milliseconds before the child is killed. */
  timeout?: number;
  /** Base environment, `process.env` by default; {@link OPENSPEC_ENV} always wins. */
  env?: NodeJS.ProcessEnv;
  /** The CLI to run instead of the located one, e.g. when vendoring from a given CLI. */
  bin?: string;
}

/**
 * `code` is 1 when the CLI is missing or fails to start, with Mate's message as
 * `stderr`; `null` when the child was killed. With `stdio: "inherit"` only that
 * message is returned, the CLI's own output went to the terminal.
 */
export interface OpenSpecRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the bundled CLI is missing, so nothing ran. */
  missing?: true;
}

export type RunOpenSpec = (args: string[], options: OpenSpecRunOptions) => Promise<OpenSpecRun>;

function readVersion(bin: string): string | undefined {
  try {
    const manifest = path.resolve(path.dirname(bin), "../package.json");
    return (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Finds the OpenSpec CLI shipped with mate-core the way Node resolves it, never
 * an `openspec` on `PATH`. `resolve` exists for layout tests.
 */
export function resolveOpenSpec(
  resolve: (id: string) => string = require.resolve,
): OpenSpecLocation {
  let entryPath: string;
  try {
    // The package exports only `.` (dist/index.js); the binary sits beside dist/.
    entryPath = resolve("@fission-ai/openspec");
  } catch {
    return { missing: "bundled OpenSpec CLI is missing. Reinstall Mate to restore it." };
  }
  const bin = path.resolve(path.dirname(entryPath), "../bin/openspec.js");
  if (!fs.existsSync(bin)) {
    return { missing: `bundled OpenSpec CLI is missing at ${bin}. Reinstall Mate to restore it.` };
  }
  return { bin, version: readVersion(bin) };
}

/** The one in-process seam: suites point `locate` at a stub CLI. */
export const openSpecCliDeps = {
  locate: (): OpenSpecLocation => resolveOpenSpec(),
};

/** The CLI every OpenSpec process Mate starts runs. */
export function locateOpenSpec(): OpenSpecLocation {
  return openSpecCliDeps.locate();
}

/** Runs the bundled CLI with {@link OPENSPEC_ENV} over the base environment. Never rejects. */
export function runOpenSpec(args: string[], options: OpenSpecRunOptions): Promise<OpenSpecRun> {
  const location = options.bin ? { bin: options.bin } : locateOpenSpec();
  if ("missing" in location) {
    return Promise.resolve({ code: 1, stdout: "", stderr: location.missing, missing: true });
  }
  return new Promise((resolve) => {
    // A JS entry runs on the current runtime, not its `#!/usr/bin/env node` shebang,
    // which needs an executable bit and `node` on PATH and does not work on Windows.
    const [command, commandArgs] = location.bin.endsWith(".js")
      ? [process.execPath, [location.bin, ...args]]
      : [location.bin, args];
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), ...OPENSPEC_ENV },
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) =>
      resolve({ code: 1, stdout, stderr: `failed to run openspec: ${error.message}` }),
    );
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
