import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { preparePrebuiltWorkspace } from "../../../lib/prebuilt-workspace-prepare";

const companionPrepareCommandDeps = {
  preparePrebuiltWorkspace,
};

interface ParsedPrepareArgs {
  bundle?: string;
  companionPath?: string;
  error?: string;
}

function parsePrepareArgs(argv: string[]): ParsedPrepareArgs {
  let bundle: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--from") {
      const value = argv[++index];
      if (!value) return { error: "`--from` requires a path to a prebuilt dependency bundle." };
      bundle = value;
      continue;
    }
    if (arg.startsWith("--from=")) {
      bundle = arg.slice("--from=".length);
      if (!bundle) return { error: "`--from` requires a path to a prebuilt dependency bundle." };
      continue;
    }
    if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    positional.push(arg);
  }

  if (positional.length > 1) return { error: "`companion prepare` accepts at most one path." };
  if (!bundle) return { error: "`companion prepare` requires `--from <bundle>`." };
  return { bundle, companionPath: positional[0] };
}

/**
 * @command mate companion prepare --from <bundle> [companion-path]
 * @description Prepares the companion's machine-local dependency workspace by
 * validating and copying a fully installed prebuilt bundle. Runs no package
 * manager, no dependency resolution, and no installation script; presents no
 * selection and changes none.
 * @flags
 * - `--from PATH` — the prebuilt, fully installed workspace to copy.
 */
export async function runCompanionPrepareCommand(argv: string[] = []): Promise<void> {
  const parsed = parsePrepareArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${FRAMEWORK_NAME}: ${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }

  const companionPath = path.resolve(parsed.companionPath ?? process.cwd());
  const result = await companionPrepareCommandDeps.preparePrebuiltWorkspace(
    companionPath,
    path.resolve(parsed.bundle!),
  );

  if (!result.ok) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: cannot prepare local dependencies:\n${result.failures.map((failure) => `  ${failure}`).join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${result.reused ? "Reused" : "Prepared"} local dependencies at ${result.workspacePath}\n`,
  );
}
