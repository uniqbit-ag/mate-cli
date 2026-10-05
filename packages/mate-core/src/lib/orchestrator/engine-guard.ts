import semver from "semver";

import type { FrameworkConfig } from "./types";

export interface EngineRequirementResult {
  ok: boolean;
  reason?: string;
}

/**
 * Check the companion's engines requirement for the running distribution.
 * Only `engines[distributionName]` is considered; keys declared for other
 * distributions are ignored.
 */
export function checkEngineRequirement(
  config: FrameworkConfig,
  distributionName: string,
  currentVersion: string,
): EngineRequirementResult {
  const range = config.engines?.[distributionName];
  if (!range) return { ok: true };

  if (semver.validRange(range) === null) {
    return {
      ok: false,
      reason: `This companion declares an invalid engines.${distributionName} version range: "${range}".`,
    };
  }

  const current = semver.parse(currentVersion);
  const currentReleaseVersion =
    current && current.prerelease.length > 0
      ? `${current.major}.${current.minor}.${current.patch}`
      : null;
  const satisfied =
    semver.satisfies(currentVersion, range, { includePrerelease: true }) ||
    (currentReleaseVersion !== null &&
      semver.satisfies(currentReleaseVersion, range, { includePrerelease: true }));
  if (!satisfied) {
    return {
      ok: false,
      reason: `This companion requires ${distributionName} ${range}, but ${currentVersion} is installed. Run \`${distributionName} update\`.`,
    };
  }
  return { ok: true };
}
