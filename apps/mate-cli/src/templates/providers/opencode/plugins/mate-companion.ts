import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { readContext, type CompanionContext } from "./mate-companion-policy";

const GUIDANCE_FILE = ".mate-guidance.json";

type GuidanceFile = {
  version?: number;
  companionGuidance?: string;
  codebaseExplorationGuidance?: string;
  errors?: string[];
};

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const entries = (pathValue ?? "").split(path.delimiter).filter(Boolean);
  return [entry, ...entries.filter((value) => value !== entry)].join(path.delimiter);
}

function isTemplateSource(): boolean {
  return import.meta.url.includes("/src/templates/providers/opencode/plugins/mate-companion.ts");
}

function loadGuidanceFile(context: CompanionContext): Required<GuidanceFile> {
  const guidancePath = path.join(context.companionPath, ".opencode", GUIDANCE_FILE);
  let parsed: GuidanceFile;

  try {
    parsed = JSON.parse(fs.readFileSync(guidancePath, "utf8")) as GuidanceFile;
  } catch (error) {
    if (isTemplateSource()) {
      return {
        version: 1,
        companionGuidance: "__MATE_COMPANION_GUIDANCE_PLACEHOLDER__",
        codebaseExplorationGuidance: "",
        errors: [],
      };
    }
    throw new Error(
      [
        "Mate OpenCode companion plugin is incomplete and cannot start.",
        `- missing or unreadable guidance file: ${guidancePath}`,
        "Repair the companion runtime by re-running `mate companion setup` or `mate opencode`.",
      ].join("\n"),
      { cause: error },
    );
  }

  const errors = Array.isArray(parsed.errors) ? parsed.errors.filter(Boolean) : [];

  if (parsed.version !== 1) {
    errors.push("unsupported guidance file version");
  }

  if (typeof parsed.companionGuidance !== "string" || !parsed.companionGuidance.trim()) {
    errors.push("missing injected companion guidance");
  } else if (!parsed.companionGuidance.includes("<companion-policy ")) {
    errors.push("injected companion guidance is malformed");
  }

  if (typeof parsed.codebaseExplorationGuidance !== "string") {
    errors.push("missing injected codebase exploration guidance");
  } else if (
    parsed.codebaseExplorationGuidance.trim() &&
    !parsed.codebaseExplorationGuidance.includes("<codebase-exploration-rules ")
  ) {
    errors.push("injected codebase exploration guidance is malformed");
  }

  if (errors.length > 0 && !isTemplateSource()) {
    throw new Error(
      [
        "Mate OpenCode companion plugin is incomplete and cannot start.",
        ...errors.map((error) => `- ${error}`),
        "Repair the companion runtime by re-running `mate companion setup` or `mate opencode`.",
      ].join("\n"),
    );
  }

  return {
    version: 1,
    companionGuidance: parsed.companionGuidance ?? "",
    codebaseExplorationGuidance: parsed.codebaseExplorationGuidance ?? "",
    errors,
  };
}

function materializeCompanionGuidance(guidance: string, context: CompanionContext): string {
  const wrapperBinPath = process.env.MATE_WRAPPER_BIN_PATH ?? "$MATE_WRAPPER_BIN_PATH";
  return guidance
    .replaceAll("$MATE_REPO_PATH", context.repositoryPath)
    .replaceAll("$MATE_ARTIFACT_PATH", context.companionPath)
    .replaceAll("$MATE_WRAPPER_BIN_PATH", wrapperBinPath)
    .replaceAll("$MATE_REPO_ID", context.repositoryId)
    .replaceAll("$MATE_REPO_PROFILE", context.repositoryProfile);
}

function buildSystemPrompt(context: CompanionContext, guidance: Required<GuidanceFile>): string[] {
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
  const context = readContext(process.env.MATE_ARTIFACT_PATH ?? "");
  if (!context.companionPath || !context.repositoryPath) {
    return {};
  }

  const guidance = loadGuidanceFile(context);

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
                repositoryProfile: context.repositoryProfile,
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
      output.context.push(buildSystemPrompt(context, guidance).join("\n"));
    },
    "shell.env": async (
      _input: any,
      output: {
        env: {
          MATE_NAME: string;
          MATE_VERSION: string;
          MATE_ARTIFACT_PATH: string;
          MATE_WRAPPER_BIN_PATH: string;
          MATE_REPO_PATH: string;
          MATE_REPO_ID: string;
          MATE_REPO_PROFILE: string;
          MATE_POLICY_JSON: string;
          MATE_GRAPHIFY_ENABLED: string;
          MATE_GIT_AUTO_MODE: string;
          PATH: string;
        };
      },
    ) => {
      output.env.MATE_NAME = context.frameworkName;
      output.env.MATE_VERSION = process.env.MATE_VERSION ?? "unknown";
      output.env.MATE_ARTIFACT_PATH = context.companionPath;
      output.env.MATE_WRAPPER_BIN_PATH = wrapperBinPath;
      output.env.MATE_REPO_PATH = context.repositoryPath;
      output.env.MATE_REPO_ID = context.repositoryId;
      output.env.MATE_REPO_PROFILE = context.repositoryProfile;
      output.env.MATE_POLICY_JSON = context.policyJson;
      output.env.MATE_GRAPHIFY_ENABLED = context.graphifyEnabled ? "1" : "0";
      output.env.MATE_GIT_AUTO_MODE = context.gitAutoModeEnabled ? "1" : "0";

      output.env.PATH = prependPathEntry(process.env.PATH, wrapperBinPath);
    },
  };
};

export default CompanionPlugin;
