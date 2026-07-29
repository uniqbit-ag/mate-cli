import { getActiveDistribution } from "../distribution";
import { frameworkCommandName } from "../framework";
import { resolveInstallContext } from "../lib/install";
import type { FrameworkConfig } from "../lib/orchestrator/types";
import type { Plugin, PluginCliCommand } from "../tools/setup/plugin";

function namespaceOf(plugin: Plugin): string {
  return plugin.cliNamespace ?? plugin.id;
}

function pluginForNamespace(namespace: string): Plugin | undefined {
  return getActiveDistribution()
    .registry.getAll()
    .find((candidate) => namespaceOf(candidate) === namespace);
}

/**
 * Dispatch `<distribution> cap <namespace> <name>` to a plugin-declared CLI
 * command. Returns true when the namespace belongs to a plugin that declares
 * CLI commands (the invocation is then fully handled here, including
 * unknown-subcommand errors); false when no plugin claims the namespace so
 * the caller can report an unknown command. Framework `cap` subcommands are
 * dispatched before this is consulted, so they can never be shadowed.
 *
 * Commands are mounted independently of plugin selection: the MCP descriptors
 * written during setup must stay launchable even when enablement is evaluated
 * lazily. Commands guard their own preconditions.
 */
export async function runPluginCliCommand(
  namespace: string,
  commandName: string | undefined,
  argv: string[],
): Promise<boolean> {
  const plugin = pluginForNamespace(namespace);
  const commands = plugin?.cliCommands;
  if (!plugin || !commands || commands.length === 0) return false;

  const command = findPluginCliCommand(namespace, commandName);
  if (!command) {
    console.error(
      commandName
        ? `Unknown command: cap ${namespace} ${commandName}`
        : `Missing subcommand for: cap ${namespace}`,
    );
    console.error(usageFor(plugin));
    process.exitCode = 1;
    return true;
  }

  await command.run(argv);
  return true;
}

/**
 * Look up a plugin-declared CLI command without running it. Used by `main` to
 * detect plugin-owned invocations early — plugin commands own their stdout
 * (e.g. an MCP server speaking JSON-RPC), so the CLI must not print banners
 * before dispatching to one.
 */
export function findPluginCliCommand(
  namespace: string | undefined,
  commandName: string | undefined,
): PluginCliCommand | undefined {
  if (!namespace || !commandName) return undefined;
  return pluginForNamespace(namespace)?.cliCommands?.find(
    (candidate) => candidate.name === commandName,
  );
}

export interface EnsureCapabilityEnabledDeps {
  loadConfig?: () => Promise<FrameworkConfig>;
}

/**
 * Guard for plugin CLI commands: verifies the owning plugin's capability is
 * enabled in the resolved companion configuration. On failure it prints a
 * message naming the capability and how to enable it, sets a non-zero exit
 * code, and returns false so the command can bail out without side effects.
 */
export async function ensureCapabilityEnabled(
  pluginId: string,
  deps: EnsureCapabilityEnabledDeps = {},
): Promise<boolean> {
  const distribution = getActiveDistribution();
  const plugin = distribution.registry.getAll().find((candidate) => candidate.id === pluginId);
  const loadConfig = deps.loadConfig ?? (async () => (await resolveInstallContext()).config);
  if (plugin?.isEnabled(await loadConfig())) return true;

  const name = frameworkCommandName();
  console.error(
    `${name}: the "${pluginId}" capability is not enabled for this companion. ` +
      `Enable it via \`${name} companion setup\`.`,
  );
  process.exitCode = 1;
  return false;
}

function formatCommand(
  distributionName: string,
  namespace: string,
  command: PluginCliCommand,
): string {
  return `  ${distributionName} cap ${namespace} ${command.name}  ${command.description}`;
}

function usageFor(plugin: Plugin): string {
  const distributionName = frameworkCommandName();
  const namespace = namespaceOf(plugin);
  const lines = (plugin.cliCommands ?? []).map((command) =>
    formatCommand(distributionName, namespace, command),
  );
  return ["Available commands:", ...lines].join("\n");
}

/**
 * Cap-command lines contributed by every registered plugin that declares
 * `cliCommands` (compiled-in or companion-declared/dynamic), formatted as
 * ` <n> cap <namespace> <name>  <description>`. Used by `usage()` so plugin
 * commands show up in `mate help` alongside framework builtins.
 */
export function pluginCliCommandLines(): string[] {
  const distributionName = frameworkCommandName();
  return getActiveDistribution()
    .registry.getAll()
    .flatMap((plugin) =>
      (plugin.cliCommands ?? []).map((command) =>
        formatCommand(distributionName, namespaceOf(plugin), command),
      ),
    );
}
