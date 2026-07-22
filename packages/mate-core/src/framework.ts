import { getActiveDistribution } from "./distribution";

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
