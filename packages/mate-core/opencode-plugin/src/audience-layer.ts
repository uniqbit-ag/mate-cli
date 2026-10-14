import type { Context } from "@opencode/plugin/promise/plugin";

import { repositoryWrappedForOpenCode } from "../../src/opencode/companion-hooks";
import { currentAudienceLayer } from "../../src/runtime/audience-layer";
import { MATE_ENV } from "../../src/runtime/env";
import { parseGuidanceContent } from "../../src/runtime/guidance";
import {
  readOpenCodeAudienceLayer,
  type OpenCodeLayerContents,
} from "../../src/runtime/opencode-audience-layer";
import { readWrapStateSync } from "../../src/runtime/wrap-state";
import type { LaunchEnvironment } from "./launch-environment";

export interface TrustedAudienceLayer {
  root: string;
  contents: OpenCodeLayerContents;
}

/**
 * The audience layer named by a payload the plugin trusts. `env` is the
 * launch environment `pluginLaunchEnvironment` decided on, so a masked
 * payload, a bare session and the shared service all read as `{}` here and
 * never apply a layer.
 */
export async function readTrustedAudienceLayer(
  env: LaunchEnvironment,
): Promise<TrustedAudienceLayer | null> {
  const payload = env[MATE_ENV.guidanceJson];
  if (!payload?.trim()) return null;
  const root = parseGuidanceContent(payload).guidance.audienceLayer;
  if (!root) return null;
  return { root, contents: await readOpenCodeAudienceLayer(root) };
}

/**
 * The layer of the audience the session's checkout is wrapped for. The wrap is
 * resolved from the session's own directory, so the shared service serves each
 * checkout its own audience; the environment never selects one.
 */
export async function readWrappedAudienceLayer(
  directory: string,
  companionPath: string,
): Promise<TrustedAudienceLayer | null> {
  const repoRoot = repositoryWrappedForOpenCode(directory);
  if (!repoRoot) return null;
  const audience = readWrapStateSync(repoRoot).audience;
  if (!audience) return null;
  const root = currentAudienceLayer(companionPath, audience);
  return root ? { root, contents: await readOpenCodeAudienceLayer(root) } : null;
}

/**
 * Applies a layer's MCP servers, skills and agents through the plugin API. A
 * new agent id is created by updating it; its prompt goes in `system`.
 */
export async function registerAudienceLayer(
  api: Context,
  layer: OpenCodeLayerContents,
): Promise<void> {
  if (layer.mcpServers.length > 0) {
    await api.mcp.transform((editor) => {
      for (const server of layer.mcpServers) editor.set(server.name, server.config as never);
    });
  }

  if (layer.skills.length > 0) {
    await api.skill.transform((editor) => {
      for (const skill of layer.skills) {
        if (editor.get(skill.id)) {
          editor.update(skill.id, (current) => Object.assign(current, skill));
        } else {
          editor.add(skill as never);
        }
      }
    });
  }

  if (layer.agents.length > 0) {
    await api.agent.transform((editor) => {
      for (const agent of layer.agents) {
        editor.update(agent.id, (current) => {
          const target = current as Record<string, unknown>;
          target.name ??= agent.id;
          if (agent.description) target.description = agent.description;
          target.mode = agent.mode;
          target.system = agent.system;
        });
      }
    });
  }
}
