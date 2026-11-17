import { format } from "node:util";

import { main } from "./cli/main";
import { setActiveDistribution, type DistributionConfig } from "./distribution";
import { FRAMEWORK_NAME } from "./framework";
import { currentSession } from "./lib/session-attribution";
import {
  nudgeLine,
  recordCommandFailure,
  withoutArgumentValues,
} from "./runtime/friction-recorder";
import { maskSecretValues } from "./runtime/secret-values";
import { createBunPlugin } from "./tools/setup/package-managers/bun";
import { createUvPlugin } from "./tools/setup/package-managers/uv";
import type { PluginRegistration } from "./tools/setup/plugin";
import { createGitignorePlugin } from "./tools/setup/plugins/gitignore";
import { PluginRegistry } from "./tools/setup/registry";

export interface CreateMateOptions {
  config: DistributionConfig;
  plugins: PluginRegistration[];
  /** Optional entry-point override for embedders that need to control CLI execution. */
  main?: typeof main;
}

export interface MateCli {
  config: DistributionConfig;
  registry: PluginRegistry;
  run(argv?: string[]): Promise<void>;
}

/**
 * Assemble a distribution from an identity config and plugin registration
 * entries. Distributions choose their plugin set; the framework always adds
 * bun as the required runtime substrate, uv for the capabilities that install
 * through it (enabled only by them, e.g. Graphify), plus gitignore management
 * named after the framework identity (built last since it reads the full
 * plugin set). Returns the runnable CLI.
 */
export function createMate({ config, plugins, main: runMain = main }: CreateMateOptions): MateCli {
  const registry = new PluginRegistry([
    ...plugins,
    { plugin: createBunPlugin(), policy: "required" },
    { plugin: createUvPlugin(), policy: "optional" },
    createGitignorePlugin(FRAMEWORK_NAME),
  ]);
  setActiveDistribution({ config, registry });
  return {
    config,
    registry,
    run: async (argv = process.argv) => {
      const session = currentSession(process.env);
      const args = argv.slice(2);
      const errors = session
        ? captureErrorTail((text) =>
            maskSecretValues(withoutArgumentValues(text, args), process.env),
          )
        : null;
      const record = (exitCode: number) => {
        if (!session || !errors || exitCode === 0) return;
        const recorded = recordCommandFailure({
          args,
          exitCode,
          errorText: errors.text(),
          session,
          mateVersion: config.version,
          env: process.env,
          cwd: process.cwd(),
        });
        if (recorded?.firstInSession) process.stderr.write(`${nudgeLine(recorded.id)}\n`);
      };
      // Some commands end with `process.exit()`, so `main` never settles for them.
      if (session) process.once("exit", record);
      try {
        await runMain(argv);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      } finally {
        process.off("exit", record);
        errors?.restore();
      }
      record(Number(process.exitCode ?? 0));
    },
  };
}

const ERROR_TAIL_LIMIT = 1_000;

/**
 * Copies `console.error` and `process.stderr.write` text into a bounded tail;
 * the original still prints first. Each piece is redacted before the tail is
 * cut, so a cut never leaves an unmatched fragment of an argument value.
 */
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
    } catch {
      // capture never changes output
    }
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
    // A command that replaced either itself keeps its replacement.
    restore: () => {
      if (console.error === error) console.error = originalError;
      if (process.stderr.write === write) process.stderr.write = originalWrite;
    },
  };
}
