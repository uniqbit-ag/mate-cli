import { getActiveDistribution } from "../distribution";
import { FRAMEWORK_NAME } from "../framework";
import { pluginCliCommandLines } from "./plugin-commands";

export function usage(): string {
  const n = FRAMEWORK_NAME;
  const packageName =
    getActiveDistribution().config.update?.packageName ?? `@uniqbit/${FRAMEWORK_NAME}`;
  return [
    `Mate CLI (${packageName})`,
    "",
    "Commands:",
    ` ${n} install [--yes]`,
    ` ${n} companion link`,
    ` ${n} companion setup`,
    ` ${n} companion list`,
    ` ${n} companion select <id>`,
    ` ${n} companion open`,
    ` ${n} companion tui`,
    ` ${n} workspace list --json`,
    ` ${n} workspace materialize --repository ID --companion PATH --json`,
    ` ${n} hub init [folder]`,
    ` ${n} hub add [source] [--id ID] [--path PATH]`,
    ` ${n} hub sync [--json] (companions + hub plugins)`,
    ` ${n} artifact finish <change-name> [--type openspec] [--force] [--no-push] [--json]`,
    ` ${n} sync [--check] [--no-git]`,
    ` ${n} doctor`,
    ` ${n} report [--days N] [--input FILE|-] [--json]`,
    ` ${n} config`,
    ` ${n} claude [args...] (use -- --no-git to bypass companion Git sync)`,
    ` ${n} opencode [args...] (use -- --no-git to bypass companion Git sync)`,
    ` ${n} cap openspec <subcommand> [args...]`,
    ` ${n} cap graphify <subcommand> [args...]`,
    ` ${n} cap index [--graphify] [--tokensave]`,
    ` ${n} mcp status [--json]`,
    ` ${n} mcp shim (stdio MCP gateway endpoint for agent hosts)`,
    ` ${n} plugin install <package>[@version]`,
    ...pluginCliCommandLines(),
    ` ${n} update`,
    ` ${n} update --check`,
    "",
    "Doctor states:",
    " linked-working-repository — cwd is inside a registered working repository",
    " companion-repository — cwd is the companion repository itself",
    " not-linked — cwd is not linked to any companion",
    "",
  ].join("\n");
}
