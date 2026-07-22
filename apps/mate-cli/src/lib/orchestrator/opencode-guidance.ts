import { GUIDANCE_FILE_VERSION, type MateGuidanceFile } from "@uniqbit/mate-core";

import {
  buildCodebaseExplorationGuidanceSection,
  buildCompanionGuidance,
} from "../../playbooks/companion-guidance";

/**
 * Build the companion guidance payload delivered to the OpenCode plugin
 * through the `MATE_GUIDANCE_JSON` launch environment variable. The guidance
 * text carries `$MATE_*` placeholders; the plugin materializes them from the
 * session environment, so the same payload shape serves every companion.
 */
export function buildOpenCodeGuidance(
  graphifyEnabled: boolean,
  tokensaveEnabled: boolean,
): MateGuidanceFile {
  const companionGuidance = buildCompanionGuidance(
    {
      companionPath: "$MATE_ARTIFACT_PATH",
      repository: {
        id: "$MATE_REPO_ID",
        path: "$MATE_REPO_PATH",
        profile: "$MATE_REPO_PROFILE",
      },
      policy: { allowedAgents: [] },
      capabilities: [],
    },
    { wrapperBinPath: "$MATE_WRAPPER_BIN_PATH" },
  );
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
