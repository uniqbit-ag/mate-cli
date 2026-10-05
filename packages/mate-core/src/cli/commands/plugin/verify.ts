import { FRAMEWORK_NAME } from "../../../framework";
import { resolveInstallContext } from "../../../lib/install";
import { verifyDeclaredPlugins } from "../../../tools/setup/dynamic-plugins/verify";

/**
 * @command mate plugin verify
 * @description Strict, installation-free check that every plugin declared by the companion is allowed by `MATE_ALLOWED_PLUGINS`, installed, and loadable with the current environment. Exits non-zero naming each failing package.
 */
export async function runPluginVerifyCommand(cwd = process.cwd()): Promise<boolean> {
  const context = await resolveInstallContext(cwd);
  if ((context.kind !== "companion" && context.kind !== "hub") || !context.companionPath) {
    process.stderr.write(`${FRAMEWORK_NAME}: \`plugin verify\` requires a companion context.\n`);
    process.exitCode = 1;
    return false;
  }
  const failures = await verifyDeclaredPlugins(context.companionPath);
  for (const failure of failures) {
    process.stderr.write(`${FRAMEWORK_NAME}: plugin ${failure.package}: ${failure.reason}\n`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
    return false;
  }
  return true;
}
