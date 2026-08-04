import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { resolveInstallContext } from "../../../lib/install";
import { ConfigStore } from "../../../lib/orchestrator/config-store";
import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { hydrateDynamicPlugins } from "../../../tools/setup/dynamic-plugins/hydrate";
import {
  installDeclaredPlugins,
  type PluginInstallDeps,
} from "../../../tools/setup/dynamic-plugins/install";
import { reportPluginInstallResults } from "../install";

export function parsePackageSpec(spec: string): { package: string; version: string } {
  const atIndex = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
  if (atIndex === -1) return { package: spec, version: "latest" };
  return { package: spec.slice(0, atIndex), version: spec.slice(atIndex + 1) };
}

function withDeclaration(
  declarations: PluginDeclaration[],
  packageName: string,
  version: string,
): PluginDeclaration[] {
  const existing = declarations.find((declaration) => declaration.package === packageName);
  if (existing?.version === version) return declarations;
  if (!existing) return [...declarations, { package: packageName, version }];
  return declarations.map((declaration) =>
    declaration.package === packageName ? { ...declaration, version } : declaration,
  );
}

export interface PluginInstallCommandDeps {
  cwd?: string;
  installDeps?: PluginInstallDeps;
}

/**
 * @command mate plugin install <package>[@version]
 * @description Declares `<package>` in the companion's (or hub's) `framework.yaml`
 * `plugins:` list (adding it, or updating its version if already declared)
 * and installs it immediately into the shared workspace, the same way
 * `mate install` would on its next run.
 */
export async function runPluginInstallCommand(
  argv: string[],
  deps: PluginInstallCommandDeps = {},
): Promise<boolean> {
  const spec = argv[0];
  if (!spec) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: usage: ${FRAMEWORK_NAME} plugin install <package>[@version]\n`,
    );
    process.exitCode = 1;
    return false;
  }
  const { package: packageName, version } = parsePackageSpec(spec);

  const context = await resolveInstallContext(deps.cwd ?? process.cwd());
  if (context.kind === "ambiguous") {
    process.stderr.write(`${context.message}\n`);
    process.exitCode = 1;
    return false;
  }
  if ((context.kind !== "companion" && context.kind !== "hub") || !context.companionPath) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: \`plugin install\` requires a companion or hub context; run it from inside a linked working repository or a hub root.\n`,
    );
    process.exitCode = 1;
    return false;
  }

  const configPath = path.join(
    context.companionPath,
    `.${FRAMEWORK_NAME}`,
    "config",
    "framework.yaml",
  );
  const store = new ConfigStore(configPath);
  const nextPlugins = withDeclaration(context.config.plugins ?? [], packageName, version);
  if (nextPlugins !== context.config.plugins) {
    await store.save({ ...context.config, plugins: nextPlugins });
  }

  const results = await installDeclaredPlugins(
    context.companionPath,
    nextPlugins,
    deps.installDeps,
  );
  reportPluginInstallResults(results);
  await hydrateDynamicPlugins({ companionPath: context.companionPath });

  return results.find((result) => result.package === packageName)?.status !== "failed";
}
