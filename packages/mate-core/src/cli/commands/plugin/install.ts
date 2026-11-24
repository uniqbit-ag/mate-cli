import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { resolveInstallContext } from "../../../lib/install";
import { backfillHubAllowedAgents } from "../../../lib/orchestrator/companion-hub";
import { ConfigStore } from "../../../lib/orchestrator/config-store";
import type { FrameworkConfig, PluginDeclaration } from "../../../lib/orchestrator/types";
import { applySetupCompatibilities, syncCompanionFiles } from "../../../tools/setup";
import {
  describeUnknownAudience,
  readAudienceSelection,
  resolveAudience,
} from "../../../tools/setup/dynamic-plugins/audiences";
import { hydrateDynamicPlugins } from "../../../tools/setup/dynamic-plugins/hydrate";
import type { PluginInstallDeps } from "../../../tools/setup/dynamic-plugins/install";
import {
  committedDeclarationProblems,
  declareLocalPlugin,
} from "../../../tools/setup/dynamic-plugins/local";
import { installPluginWorkspaces } from "../../../tools/setup/dynamic-plugins/workspaces";
import { reportPluginInstallResults, reportPluginWorkspaces } from "../install";

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

/** The local file sits in another directory, so a relative `file:` path is taken from `cwd` now. */
function absoluteFileSpec(version: string, cwd: string): string {
  if (!version.startsWith("file:") || version.startsWith("file://")) return version;
  const target = version.slice("file:".length);
  if (target.startsWith("~/") || path.isAbsolute(target)) return version;
  return `file:${path.resolve(cwd, target)}`;
}

const INSTALL_USAGE = `usage: ${FRAMEWORK_NAME} plugin install [--local] <package>[@version]`;

export interface PluginInstallCommandDeps {
  cwd?: string;
  installDeps?: PluginInstallDeps;
  setupHub?: (companionPath: string, config: FrameworkConfig) => Promise<void>;
  syncCompanion?: (companionPath: string, config: FrameworkConfig) => Promise<unknown>;
}

function refuse(message: string): false {
  process.stderr.write(`${FRAMEWORK_NAME}: ${message}\n`);
  process.exitCode = 1;
  return false;
}

/**
 * @command mate plugin install [--local] <package>[@version]
 * @description Declares `<package>` in the companion's (or hub's) `framework.yaml`
 * `plugins:` list (adding it, or updating its version if already declared)
 * and installs it immediately into the shared workspace, the same way
 * `mate install` would on its next run: with the selected audience's
 * plugins, and without any other audience's. A successful install in a
 * companion then syncs the companion's agent runtime settings, as
 * `mate install` does.
 * @flags
 * - `--local` — declare the package in the untracked `.mate/config/framework.local.yaml` and install it into the ignored `.mate/local-plugins/`, for this machine only. No tracked file names it. A relative `file:` path is resolved from the current directory and written as an absolute path. Refused in a hub and for a package `framework.yaml` declares.
 */
export async function runPluginInstallCommand(
  argv: string[],
  deps: PluginInstallCommandDeps = {},
): Promise<boolean> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${INSTALL_USAGE}\n`);
    return true;
  }
  const local = argv.includes("--local");
  const unknownOption = argv.find((arg) => arg.startsWith("-") && arg !== "--local");
  const spec = argv.find((arg) => !arg.startsWith("-"));
  if (unknownOption || !spec) {
    const problem = unknownOption ? `unknown option ${unknownOption}; ` : "";
    return refuse(`${problem}${INSTALL_USAGE}`);
  }
  const cwd = deps.cwd ?? process.cwd();
  const parsed = parsePackageSpec(spec);
  const packageName = parsed.package;
  const version = local ? absoluteFileSpec(parsed.version, cwd) : parsed.version;

  const context = await resolveInstallContext(cwd);
  if (context.kind === "ambiguous") {
    process.stderr.write(`${context.message}\n`);
    process.exitCode = 1;
    return false;
  }
  if ((context.kind !== "companion" && context.kind !== "hub") || !context.companionPath) {
    return refuse(
      "`plugin install` requires a companion or hub context; run it from inside a linked working repository or a hub root.",
    );
  }

  // A hub declares no audiences; the selection only applies to a companion.
  let audience: string | null = null;
  if (context.kind === "companion") {
    const resolved = resolveAudience(context.config, readAudienceSelection(process.env));
    if (!resolved.ok) return refuse(describeUnknownAudience(resolved));
    audience = resolved.active;
  }

  let nextConfig = context.config;
  if (local) {
    const problems = await declareLocalPlugin(
      context.companionPath,
      context.config,
      packageName,
      version,
    );
    if (problems.length > 0) {
      return refuse(problems.map((problem) => problem.message).join("\n"));
    }
  } else {
    const problems = await committedDeclarationProblems(
      context.companionPath,
      context.config,
      packageName,
    );
    if (problems.length > 0) {
      return refuse(problems.map((problem) => problem.message).join("\n"));
    }
    const configPath = path.join(
      context.companionPath,
      `.${FRAMEWORK_NAME}`,
      "config",
      "framework.yaml",
    );
    const store = new ConfigStore(configPath);
    const nextPlugins = withDeclaration(context.config.plugins ?? [], packageName, version);
    nextConfig = { ...context.config, plugins: nextPlugins };
    const agentsBackfilled = context.kind === "hub" && backfillHubAllowedAgents(nextConfig);
    if (nextPlugins !== context.config.plugins || agentsBackfilled) {
      await store.save(nextConfig);
    }
  }

  const outcome = await installPluginWorkspaces(context.companionPath, nextConfig, audience, {
    installDeps: deps.installDeps,
  });
  const { results } = outcome;
  reportPluginWorkspaces(outcome);
  reportPluginInstallResults(results);
  const succeeded =
    results.find((result) => result.package === packageName)?.status !== "failed" &&
    !results.some((result) => result.refused);
  await hydrateDynamicPlugins({ companionPath: context.companionPath });
  if (context.kind === "hub") {
    await (
      deps.setupHub ??
      ((companionPath, config) =>
        applySetupCompatibilities(companionPath, config, "sync", undefined, undefined, "hub"))
    )(context.companionPath, nextConfig);
  }
  if (context.kind === "companion" && succeeded) {
    await (deps.syncCompanion ?? syncCompanionFiles)(context.companionPath, nextConfig);
  }

  return succeeded;
}
