import {
  buildCompanionGuidance as buildCompanionGuidanceWith,
  buildCompanionPolicyXml as buildCompanionPolicyXmlWith,
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

export {
  GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT,
  buildCodebaseExplorationGuidanceSection,
  hasGraphifyCapability,
  hasOpenspecCapability,
  hasTokensaveCapability,
  type GuidanceCapability,
  type GuidanceContext,
} from "../runtime/companion-guidance";

/**
 * Build just the `<companion-policy>` XML block: paths, CLI tools, and
 * mandatory rules (including the capability-gated `openspec-finish` rule).
 * Does not include codebase-exploration guidance — see
 * `buildCompanionGuidance` for the merged single-string form, or call
 * `buildCodebaseExplorationGuidanceSection` directly when that guidance is
 * delivered through its own channel (as OpenCode's guidance contract does).
 */
export function buildCompanionPolicyXml(
  context: GuidanceContext,
  options: { wrapperBinPath?: string } = {},
): string {
  return buildCompanionPolicyXmlWith(context, {
    wrapperBinPath: options.wrapperBinPath ?? getWrapperBinPath(),
  });
}

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
