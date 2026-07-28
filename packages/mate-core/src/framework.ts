import { getActiveDistribution } from "./distribution";

/**
 * Framework identity: names everything identity-shaped regardless of how the
 * CLI is invoked — state directories (`~/.mate`, `.mate/`), managed-block
 * markers, `MATE_*` env values, and the `companion-policy framework`
 * attribute. A whitelabel distribution changes the invocation name only;
 * identity stays `mate`. Use `frameworkCommandName()` for anything the user
 * or an agent types.
 */
export const FRAMEWORK_NAME = "mate";

/**
 * Invocation name: how this distribution's CLI is invoked, derived from the
 * package's `bin` key (`config.name`). Drives usage output, command hints,
 * error prefixes, agent guidance, and permission entries — never paths,
 * markers, or env values (use `FRAMEWORK_NAME` for those).
 */
export function frameworkCommandName(): string {
  return getActiveDistribution().config.name;
}

/**
 * Live view of the active distribution's identity. Framework modules read
 * identity through this object; the values always come from the config the
 * distribution passed to `createMate` — the framework itself carries no
 * hardcoded distribution name.
 */
export const frameworkConfig = {
  get name(): string {
    return getActiveDistribution().config.name;
  },
  get legacyNames(): string[] {
    return getActiveDistribution().config.legacyNames ?? [];
  },
  get runtime(): string {
    return getActiveDistribution().config.runtime;
  },
};
