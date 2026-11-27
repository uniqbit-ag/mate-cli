import { version } from "../../../package.json";
import {
  PROJECTION_ENV_NAMES,
  PROJECTION_FIELDS,
  type MateProjection,
} from "../../runtime/projection";
import { runtimeWrapperBinPath } from "../../runtime/runtime-directory";
import { getReactDoctorBinPath, getWrapperBinPath } from "../package-paths";
import type { LinkedRepository } from "./types";

/**
 * The one derivation of the projected paths. Both the Projection Root and a
 * managed launch materialize this record, so neither can hold its own copy of a
 * layout the other computes.
 */

/**
 * Both bin paths are unconditional: a path exists whether or
 * not its Capability is enabled, and enablement is a predicate, read live from
 * the companion rather than cached here.
 *
 * The persisted record names the runtime directory so it survives a reinstall;
 * a launch passes the live install path, since its runtime-directory refresh
 * may only have warned.
 */
export function buildProjection(
  companionPath: string,
  repository: LinkedRepository,
  wrapperBinPath: string = runtimeWrapperBinPath(),
): MateProjection {
  return {
    version,
    companionPath,
    repositoryPath: repository.path,
    repositoryId: repository.id,
    wrapperBinPath,
    reactDoctorBinPath: getReactDoctorBinPath(),
  };
}

/** The record spelled as environment variables. */
export function projectionEnvironment(projection: MateProjection): NodeJS.ProcessEnv {
  return Object.fromEntries(
    PROJECTION_FIELDS.map((field) => [PROJECTION_ENV_NAMES[field], projection[field]]),
  );
}

/** Materializes the path-only subset used by a launch without a repository. */
export function companionEnvironment(companionPath: string): NodeJS.ProcessEnv {
  const values: Record<keyof MateProjection, string> = {
    version,
    companionPath,
    repositoryPath: "",
    repositoryId: "",
    wrapperBinPath: getWrapperBinPath(),
    reactDoctorBinPath: getReactDoctorBinPath(),
  };

  return Object.fromEntries(
    PROJECTION_FIELDS.map((field) => [PROJECTION_ENV_NAMES[field], values[field]]),
  );
}
