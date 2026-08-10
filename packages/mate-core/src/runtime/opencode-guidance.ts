import { GUIDANCE_FILE_VERSION, type MateGuidanceFile } from "./guidance";
import {
  buildCodebaseExplorationGuidanceSection,
  buildCompanionPolicyXml,
  type PolicyCapabilityConfig,
} from "./companion-policy-text";

/**
 * Build the companion guidance payload for OpenCode sessions. The guidance
 * text carries `$MATE_*` placeholders; the plugin materializes them from the
 * resolved companion context, so the same payload shape serves every
 * companion. Built from the companion's live capability configuration —
 * capability-gated policy rules (e.g. openspec-finish) render exactly as
 * they do for the Claude provider.
 */
export function buildOpenCodeGuidance(capabilities: PolicyCapabilityConfig[]): MateGuidanceFile {
  const companionGuidance = buildCompanionPolicyXml(
    {
      companionPath: "$MATE_ARTIFACT_PATH",
      repository: {
        id: "$MATE_REPO_ID",
        path: "$MATE_REPO_PATH",
      },
      allowedAgents: [],
      capabilities,
    },
    { wrapperBinPath: "$MATE_WRAPPER_BIN_PATH" },
  );
  const graphifyEnabled = capabilities.some((capability) => capability.name === "graphify");
  const tokensaveEnabled = capabilities.some((capability) => capability.name === "tokensave");
  const codebaseExplorationGuidance = buildCodebaseExplorationGuidanceSection({
    useGraphify: graphifyEnabled,
    useTokensave: tokensaveEnabled,
  });
  const errors: string[] = [];

  if (!companionGuidance.includes("<companion-policy ")) {
    errors.push("companion guidance was not injected");
  }
  if (
    (graphifyEnabled || tokensaveEnabled) &&
    !codebaseExplorationGuidance.includes("<codebase-exploration-rules ")
  ) {
    errors.push("codebase exploration guidance was not injected");
  }

  return {
    version: GUIDANCE_FILE_VERSION,
    companionGuidance,
    codebaseExplorationGuidance,
    errors,
  };
}
