import { getActiveDistribution } from "../distribution";
import { FRAMEWORK_NAME, frameworkCommandName } from "../framework";
import { pluginCliCommandLines } from "./plugin-commands";

export function usage(): string {
  const n = frameworkCommandName();
  const packageName =
    getActiveDistribution().config.update?.packageName ?? `@uniqbit/${FRAMEWORK_NAME}`;
  return [
    `${n.charAt(0).toUpperCase() + n.slice(1)} CLI (${packageName})`,
    "",
    "Commands:",
    ` ${n} install [--yes]`,
    ` ${n} companion link`,
    ` ${n} companion setup`,
    ` ${n} companion list`,
    ` ${n} companion open`,
    ` ${n} companion tui`,
    ` ${n} artifact finish <change-name> [--type openspec] [--force] [--no-push] [--json]`,
    ` ${n} doctor`,
    ` ${n} report [--days N] [--json]`,
    ` ${n} config`,
    ` ${n} claude [args...] (use -- --no-git to bypass companion Git sync)`,
    ` ${n} opencode [args...] (use -- --no-git to bypass companion Git sync)`,
    ` ${n} cap openspec <subcommand> [args...]`,
    ` ${n} cap graphify <subcommand> [args...]`,
    ` ${n} cap index [--graphify] [--tokensave]`,
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
