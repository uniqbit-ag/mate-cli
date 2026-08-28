import path from "node:path";

import { version } from "../../../package.json";
import {
  PROJECTION_ENV_NAMES,
  PROJECTION_FIELDS,
  type MateProjection,
} from "../../runtime/projection";
import {
  GRAPHIFY_OUTPUT_SUBDIR,
  GRAPHIFY_STORE_SEGMENT,
} from "../../tools/setup/capabilities/graphify";
import { getReactDoctorBinPath, getWrapperBinPath } from "../package-paths";
import type { LinkedRepository } from "./types";

/**
 * The one derivation of the projected paths. Both the Projection Root and a
 * managed launch materialize this record, so neither can hold its own copy of a
 * layout the other computes.
 */

/**
 * Both bin paths and `GRAPHIFY_OUT` are unconditional: a path exists whether or
 * not its Capability is enabled, and enablement is a predicate, read live from
 * the companion rather than cached here.
 */
export function buildProjection(
  companionPath: string,
  repository: LinkedRepository,
): MateProjection {
  return {
    version,
    companionPath,
    repositoryPath: repository.path,
    repositoryId: repository.id,
    wrapperBinPath: getWrapperBinPath(),
    reactDoctorBinPath: getReactDoctorBinPath(),
    graphifyOut: path.join(
      companionPath,
      GRAPHIFY_STORE_SEGMENT,
      repository.id,
      GRAPHIFY_OUTPUT_SUBDIR,
    ),
  };
}

/**
 * The record spelled as environment variables. `graphifyy` resolves its output
 * directory from `GRAPHIFY_OUT` at import time, so a launch that omitted it
 * would leak `graphify-out/` into the Working Repository.
 */
export function projectionEnvironment(projection: MateProjection): NodeJS.ProcessEnv {
  return Object.fromEntries(
    PROJECTION_FIELDS.map((field) => [PROJECTION_ENV_NAMES[field], projection[field]]),
  );
}
