import path from "node:path";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  COMPANION_POLICY_MARKER,
  MATE_ENV,
  type MateGuidanceFile,
} from "@uniqbit/mate-core/runtime";

import {
  readContext,
  resolveOpenCodeGuidance,
  type CompanionContext,
} from "@uniqbit/mate-core/opencode";

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const entries = (pathValue ?? "").split(path.delimiter).filter(Boolean);
  return [entry, ...entries.filter((value) => value !== entry)].join(path.delimiter);
}

function buildStartupError(details: string[]): Error {
  return new Error(
    [
      "Mate OpenCode companion plugin is incomplete and cannot start.",
      ...details.map((detail) => `- ${detail}`),
      "Launch through `mate opencode`, or run `mate wrap` so the guidance resolves from the Projection Root.",
    ].join("\n"),
  );
}

/**
 * Env first, projection second. A session Mate launched carries the payload;
 * an Unmanaged Session in a wrapped repository builds the same payload from the
 * companion the projection names, with the Capability names read live.
 */
function loadGuidance(): MateGuidanceFile | null {
  const { guidance, errors } = resolveOpenCodeGuidance();
  if (errors.length > 0) throw buildStartupError(errors);
  return guidance;
}

function materializeCompanionGuidance(guidance: string, context: CompanionContext): string {
  const wrapperBinPath = process.env.MATE_WRAPPER_BIN_PATH ?? "$MATE_WRAPPER_BIN_PATH";
  return guidance
    .replaceAll("$MATE_REPO_PATH", context.repositoryPath)
    .replaceAll("$MATE_ARTIFACT_PATH", context.companionPath)
    .replaceAll("$MATE_WRAPPER_BIN_PATH", wrapperBinPath)
    .replaceAll("$MATE_REPO_ID", context.repositoryId);
}

function buildSystemPrompt(context: CompanionContext, guidance: MateGuidanceFile): string[] {
  const lines = [materializeCompanionGuidance(guidance.companionGuidance, context)];

  if (guidance.codebaseExplorationGuidance.trim()) {
    lines.push("", guidance.codebaseExplorationGuidance);
  }

  if (context.agentsMd.trim()) {
    lines.push("", `<agents.md>${context.agentsMd.trim()}</agents.md>`);
  }

  return lines;
}

export const CompanionPlugin: Plugin = async () => {
  const context = readContext();
  if (!context.companionPath || !context.repositoryPath) {
    return {};
  }

  const guidance = loadGuidance();
  if (!guidance) return {};

  const wrapperBinPath = process.env.MATE_WRAPPER_BIN_PATH ?? "$MATE_WRAPPER_BIN_PATH";

  return {
    tool: {
      companion_paths: tool({
        description: `Return active ${context.frameworkName} working repository and companion framework paths.`,
        args: {},
        async execute() {
          return {
            output: JSON.stringify(
              {
                companionFrameworkPath: context.companionPath,
                wrapperBinPath,
                repositoryPath: context.repositoryPath,
                repositoryId: context.repositoryId,
                policy: JSON.parse(context.policyJson || "{}"),
              },
              null,
              2,
            ),
            metadata: {
              companionPath: context.companionPath,
              wrapperBinPath,
              repositoryPath: context.repositoryPath,
            },
          };
        },
      }),
    },
    "experimental.chat.system.transform": async (_input: any, output: { system: string[] }) => {
      // A wrapped repository lists this plugin in its own project config, so a
      // managed launch — whose OPENCODE_CONFIG_DIR names the companion, which
      // lists it too — loads it twice. The marker is what makes the second load
      // inert instead of appending the companion block a second time.
      if (output.system.some((part) => part.includes(COMPANION_POLICY_MARKER))) return;

      // Collapse the whole system prompt into a single entry. opencode expands
      // each `system[]` element into its own `role:"system"` wire message, and
      // some self-hosted chat templates (e.g. Qwen served via vLLM) reject any
      // system message that is not the very first message. Merging opencode's
      // own parts with the mate companion block guarantees exactly one leading
      // system message.
      const companion = buildSystemPrompt(context, guidance).join("\n");
      const merged = [...output.system, companion]
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join("\n\n");
      output.system.length = 0;
      if (merged.length > 0) {
        output.system.push(merged);
      }
    },
    "experimental.session.compacting": async (_input: any, output: { context: string[] }) => {
      if (output.context.some((part) => part.includes(COMPANION_POLICY_MARKER))) return;
      output.context.push(buildSystemPrompt(context, guidance).join("\n"));
    },
    "shell.env": async (_input: any, output: { env: Record<string, string> }) => {
      output.env.MATE_NAME = context.frameworkName;
      output.env.MATE_VERSION = process.env.MATE_VERSION ?? "unknown";
      output.env.MATE_ARTIFACT_PATH = context.companionPath;
      output.env.MATE_WRAPPER_BIN_PATH = wrapperBinPath;
      output.env.MATE_REPO_PATH = context.repositoryPath;
      output.env.MATE_REPO_ID = context.repositoryId;
      output.env.MATE_POLICY_JSON = context.policyJson;
      output.env.MATE_GRAPHIFY_ENABLED = context.graphifyEnabled ? "1" : "0";
      output.env.MATE_GIT_AUTO_MODE = context.gitAutoModeEnabled ? "1" : "0";
      // Session-scoped payload consumed above at plugin startup: mask it so
      // the multi-KB guidance JSON never leaks into spawned shells (and a
      // nested `mate` launch can never inherit a stale copy).
      output.env[MATE_ENV.guidanceJson] = "";

      output.env.PATH = prependPathEntry(process.env.PATH, wrapperBinPath);
    },
  };
};

export default CompanionPlugin;
