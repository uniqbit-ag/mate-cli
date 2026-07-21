import semver from "semver";

import type { FrameworkConfig } from "./types";

export interface EngineRequirementResult {
  ok: boolean;
  reason?: string;
}

export function checkMateEngineRequirement(
  config: FrameworkConfig,
  currentVersion: string,
): EngineRequirementResult {
  const range = config.engines?.mate;
  if (!range) return { ok: true };

  if (semver.validRange(range) === null) {
    return {
      ok: false,
      reason: `This companion declares an invalid engines.mate version range: "${range}".`,
    };
  }

  const satisfied = semver.satisfies(currentVersion, range, { includePrerelease: true });
  if (!satisfied) {
    return {
      ok: false,
      reason: `This companion requires mate-cli ${range}, but ${currentVersion} is installed. Run \`mate update\`.`,
    };
  }
  return { ok: true };
}
