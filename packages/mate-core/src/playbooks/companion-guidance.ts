import { FRAMEWORK_NAME } from "../framework";
import type { CapabilityConfig, GitModeProfile, LinkedRepository } from "../lib/orchestrator/types";
import { getWrapperBinPath } from "../lib/package-paths";
import {
  buildCodebaseExplorationGuidanceSection as buildCodebaseExplorationGuidanceSectionText,
  buildCompanionGuidance as buildCompanionGuidanceText,
  buildCompanionPolicyXml as buildCompanionPolicyXmlText,
} from "../runtime/companion-policy-text";

export { hasGraphifyCapability, hasTokensaveCapability } from "../lib/orchestrator/capabilities";
export { GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT } from "../runtime/companion-policy-text";

// CLI-side wrappers over the session-runtime policy text builders
// (runtime/companion-policy-text.ts): supply the framework identity and the
// resolved wrapper path, which runtime consumers must pass explicitly.

/**
 * Session identity the policy text is rendered from. Previously the launch
 * adapters' AdapterContext; sessions are no longer spawned by Mate, so the
 * SessionStart activation hook builds it from the resolved companion instead.
 */
export interface CompanionSessionContext {
  repository: LinkedRepository;
  allowedAgents: string[];
  companionPath: string;
  capabilities: CapabilityConfig[];
  git?: GitModeProfile;
}

export function buildCodebaseExplorationGuidanceSection(
  options: {
    useGraphify?: boolean;
    useTokensave?: boolean;
  } = {},
): string {
  return buildCodebaseExplorationGuidanceSectionText({
    ...options,
    frameworkName: FRAMEWORK_NAME,
  });
}

export function buildCompanionPolicyXml(
  context: CompanionSessionContext,
  options: { wrapperBinPath?: string } = {},
): string {
  return buildCompanionPolicyXmlText(context, {
    wrapperBinPath: options.wrapperBinPath ?? getWrapperBinPath(),
    frameworkName: FRAMEWORK_NAME,
  });
}

export function buildCompanionGuidance(
  context: CompanionSessionContext,
  options: { wrapperBinPath?: string } = {},
): string {
  return buildCompanionGuidanceText(context, {
    wrapperBinPath: options.wrapperBinPath ?? getWrapperBinPath(),
    frameworkName: FRAMEWORK_NAME,
  });
}
