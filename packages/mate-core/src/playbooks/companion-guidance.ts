import {
  buildCompanionGuidance as buildCompanionGuidanceWith,
  type GuidanceContext,
} from "../runtime/companion-guidance";
import { getWrapperBinPath } from "../lib/package-paths";

/**
 * The framework-side face of the guidance builders: identical output, with the
 * running installation's wrapper bin path supplied when a caller does not name
 * one. The builders themselves live in `runtime/` and take that path as data,
 * because a hook shim and the OpenCode plugin build guidance with no launch and
 * may not reach outside `runtime/`.
 *
 * A caller that is *not* the running installation — the projection reader —
 * passes the projected path instead, and so calls the runtime builders direct.
 */

export { GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT } from "../runtime/companion-guidance";

/**
 * Build the merged single-string guidance: the companion-policy XML plus
 * codebase-exploration guidance appended when graphify or tokensave is
 * enabled. Used by providers (e.g. Claude) that inject one combined prompt
 * fragment rather than delivering exploration guidance separately.
 */
export function buildCompanionGuidance(
  context: GuidanceContext,
  options: { wrapperBinPath?: string } = {},
): string {
  return buildCompanionGuidanceWith(context, {
    wrapperBinPath: options.wrapperBinPath ?? getWrapperBinPath(),
  });
}
