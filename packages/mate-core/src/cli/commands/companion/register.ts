import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { registerConfiguredCompanion } from "../../../lib/orchestrator/companion-registration";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";

export const companionRegisterCommandDeps = {
  registerConfiguredCompanion,
  createGlobalConfigStore: () => new GlobalConfigStore(),
};

/**
 * @command mate companion register [path]
 * @description Registers an already-configured Companion Repository in the
 * global registry. Presents no selection, reads no input, and writes nothing
 * inside the companion — the path a script or container entrypoint calls.
 * @remarks Defaults to the current directory. Exits non-zero when the target
 * carries no companion configuration.
 */
export async function runCompanionRegisterCommand(argv: string[] = []): Promise<void> {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  if (positional.length !== argv.length) {
    process.stderr.write(`${FRAMEWORK_NAME}: \`companion register\` accepts no flags.\n`);
    process.exitCode = 1;
    return;
  }
  if (positional.length > 1) {
    process.stderr.write(`${FRAMEWORK_NAME}: \`companion register\` accepts at most one path.\n`);
    process.exitCode = 1;
    return;
  }

  const target = path.resolve(positional[0] ?? process.cwd());
  const result = await companionRegisterCommandDeps.registerConfiguredCompanion(target, {
    globalConfigStore: companionRegisterCommandDeps.createGlobalConfigStore(),
  });

  if (!result.ok) {
    process.stderr.write(`${FRAMEWORK_NAME}: ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${result.alreadyRegistered ? "Already registered" : "Registered"} companion: ${result.companionPath}\n`,
  );
}
