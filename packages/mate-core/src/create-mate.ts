import { format } from "node:util";

import { main } from "./cli/main";
import { setActiveDistribution, type DistributionConfig } from "./distribution";
import { FRAMEWORK_NAME } from "./framework";
import { currentSession } from "./lib/session-attribution";
import { recordCommandFailure } from "./runtime/friction-recorder";
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
      const errors = session ? captureErrorTail() : null;
      const record = (exitCode: number) => {
        if (!session || !errors || exitCode === 0) return;
        recordCommandFailure({
          args: argv.slice(2),
          exitCode,
          errorText: errors.text(),
          session,
          mateVersion: config.version,
          env: process.env,
          cwd: process.cwd(),
        });
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

/** Copies `console.error` text into a bounded tail; the original still prints first. */
function captureErrorTail(): { text(): string; restore(): void } {
  const original = console.error;
  let tail = "";
  const capture = (...args: unknown[]) => {
    original(...args);
    try {
      tail = `${tail}${format(...args)}\n`.slice(-ERROR_TAIL_LIMIT);
    } catch {
      // capture never changes output
    }
  };
  console.error = capture;
  return {
    text: () => tail,
    // A command that replaced console.error itself keeps its replacement.
    restore: () => {
      if (console.error === capture) console.error = original;
    },
  };
}
