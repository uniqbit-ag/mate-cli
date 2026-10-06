import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";
import {
  COMPANION_POLICY_MARKER,
  MATE_ENV,
  type MateGuidanceFile,
} from "@uniqbit/mate-core/runtime";

import { resolveOpenCodeGuidance, type CompanionContext } from "@uniqbit/mate-core/opencode";

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const entries = (pathValue ?? "").split(path.delimiter).filter(Boolean);
  return [entry, ...entries.filter((value) => value !== entry)].join(path.delimiter);
}

function resolveWrapperBinPath(): string {
  return process.env.MATE_WRAPPER_BIN_PATH ?? "$MATE_WRAPPER_BIN_PATH";
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
function loadGuidance(directory: string): MateGuidanceFile | null {
  const { guidance, errors } = resolveOpenCodeGuidance(process.env, directory);
  if (errors.length > 0) throw buildStartupError(errors);
  return guidance;
}

function materializeCompanionGuidance(guidance: string, context: CompanionContext): string {
  const wrapperBinPath = resolveWrapperBinPath();
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

function readSystemText(part: unknown): string {
  if (typeof part === "string") return part;
  if (typeof part !== "object" || part === null || !("text" in part)) return "";
  return typeof part.text === "string" ? part.text : "";
}

/** Session-scoped variables a spawned shell sees; mutates `env` in place. */
function applyCompanionShellEnv(
  context: CompanionContext,
  env: Record<string, string | undefined>,
): void {
  const wrapperBinPath = resolveWrapperBinPath();
  env.MATE_NAME = context.frameworkName;
  env.MATE_VERSION = process.env.MATE_VERSION ?? "unknown";
  env.MATE_ARTIFACT_PATH = context.companionPath;
  env.MATE_WRAPPER_BIN_PATH = wrapperBinPath;
  if (context.repositoryPath) {
    env.MATE_REPO_PATH = context.repositoryPath;
    env.MATE_REPO_ID = context.repositoryId;
  } else {
    delete env.MATE_REPO_PATH;
    delete env.MATE_REPO_ID;
  }
  env.MATE_POLICY_JSON = context.policyJson;
  env.MATE_GRAPHIFY_ENABLED = context.graphifyEnabled ? "1" : "0";
  env.MATE_GIT_AUTO_MODE = context.gitAutoModeEnabled ? "1" : "0";
  /**
   * Session-scoped payload consumed at plugin startup: masked so the multi-KB
   * guidance JSON never leaks into spawned shells (and a nested `mate` launch
   * can never inherit a stale copy).
   */
  env[MATE_ENV.guidanceJson] = "";
  env.PATH = prependPathEntry(process.env.PATH, wrapperBinPath);
}

function companionPathsResult(context: CompanionContext) {
  const wrapperBinPath = resolveWrapperBinPath();
  return {
    content: JSON.stringify(
      {
        companionFrameworkPath: context.companionPath,
        wrapperBinPath,
        ...(context.repositoryPath
          ? { repositoryPath: context.repositoryPath, repositoryId: context.repositoryId }
          : {}),
        policy: JSON.parse(context.policyJson || "{}"),
      },
      null,
      2,
    ),
    metadata: {
      companionPath: context.companionPath,
      wrapperBinPath,
      ...(context.repositoryPath ? { repositoryPath: context.repositoryPath } : {}),
    },
  };
}

/**
 * Collapses the whole system prompt into a single entry. OpenCode sends each
 * `system[]` element as its own system message, and some self-hosted chat
 * templates (e.g. Qwen served via vLLM) reject any system message that is not
 * the very first one.
 */
function mergeCompanionSystem(system: unknown[], companion: string): string[] {
  const texts = system.map(readSystemText);
  /**
   * A wrapped repository lists this plugin in its own project config, so a
   * managed launch loads it twice; the marker keeps the second load inert.
   */
  if (texts.some((text) => text.includes(COMPANION_POLICY_MARKER))) return texts;
  const merged = [...texts, companion]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  return merged.length > 0 ? [merged] : [];
}

/** Registers guidance, compaction context, shell env, and `companion_paths`. */
export async function registerCompanion(api: Context, context: CompanionContext): Promise<void> {
  const guidance = loadGuidance(api.location.directory);
  if (!guidance) return;

  const companion = buildSystemPrompt(context, guidance).join("\n");

  await api.session.hook("context", (event) => {
    const merged = mergeCompanionSystem(event.system, companion);
    event.system.splice(
      0,
      event.system.length,
      ...merged.map((text) => ({ type: "text" as const, text }) as never),
    );
  });

  await api.session.hook("compaction", (event) => {
    if (event.system.some((part) => readSystemText(part).includes(COMPANION_POLICY_MARKER))) return;
    event.system.push({ type: "text", text: companion } as never);
  });

  await api.shell.hook("create.before", (event) => {
    applyCompanionShellEnv(context, event.env);
  });

  await api.tool.transform((editor) => {
    editor.add({
      name: "companion_paths",
      description: `Return active ${context.frameworkName} companion framework and working repository paths.`,
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return companionPathsResult(context);
      },
    });
  });
}
