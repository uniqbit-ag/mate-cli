import fs from "node:fs";
import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";
import { MATE_ENV } from "../../src/runtime/env";
import { COMPANION_POLICY_MARKER, type MateGuidanceFile } from "../../src/runtime/guidance";

import type { CompanionContext } from "../../src/opencode/companion-policy";
import type { LaunchEnvironment } from "./launch-environment";
import { resolveOpenCodeGuidance } from "../../src/opencode/projected-guidance";
import {
  runtimeDirectoryPath,
  runtimeMateBin,
  runtimeWrapperBinPath,
} from "../../src/runtime/runtime-directory";

function prependPathEntry(pathValue: string | undefined, entry: string): string {
  const entries = (pathValue ?? "").split(path.delimiter).filter(Boolean);
  return [entry, ...entries.filter((value) => value !== entry)].join(path.delimiter);
}

/**
 * The launch environment first, then the runtime directory every `mate` run
 * keeps current. `null` when neither exists: guidance naming an unresolved
 * placeholder would send the model to a path that is not there.
 */
function resolveWrapperBinPath(env: LaunchEnvironment): string | null {
  if (env.MATE_WRAPPER_BIN_PATH) return env.MATE_WRAPPER_BIN_PATH;
  const runtime = runtimeWrapperBinPath();
  return fs.existsSync(runtime) ? runtime : null;
}

/** The runtime-directory launcher for the Mate CLI; `null` until a `mate` run wrote it. */
export function resolveMateBin(): string | null {
  const launcher = runtimeMateBin();
  return fs.existsSync(launcher) ? launcher : null;
}

export function missingRuntimeDirectoryMessage(): string {
  return `Mate runtime directory ${runtimeDirectoryPath()} is missing; run \`mate\` once to repair it.`;
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
function loadGuidance(env: LaunchEnvironment, directory: string): MateGuidanceFile | null {
  const { guidance, errors } = resolveOpenCodeGuidance(env, directory);
  if (errors.length > 0) throw buildStartupError(errors);
  return guidance;
}

function materializeCompanionGuidance(
  guidance: string,
  context: CompanionContext,
  wrapperBinPath: string,
): string {
  return guidance
    .replaceAll("$MATE_REPO_PATH", context.repositoryPath)
    .replaceAll("$MATE_ARTIFACT_PATH", context.companionPath)
    .replaceAll("$MATE_WRAPPER_BIN_PATH", wrapperBinPath)
    .replaceAll("$MATE_REPO_ID", context.repositoryId);
}

function buildSystemPrompt(
  context: CompanionContext,
  guidance: MateGuidanceFile,
  wrapperBinPath: string,
  layerGuidance: string,
): string[] {
  const lines = [materializeCompanionGuidance(guidance.companionGuidance, context, wrapperBinPath)];

  if (guidance.codebaseExplorationGuidance.trim()) {
    lines.push("", guidance.codebaseExplorationGuidance);
  }

  if (context.agentsMd.trim()) {
    lines.push("", `<agents.md>${context.agentsMd.trim()}</agents.md>`);
  }

  /** The audience's guidance follows the companion's, never replaces it. */
  if (layerGuidance.trim()) {
    lines.push("", layerGuidance.trim());
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
  wrapperBinPath: string,
  launchEnv: LaunchEnvironment,
): void {
  env.MATE_NAME = context.frameworkName;
  env.MATE_VERSION = launchEnv.MATE_VERSION ?? "unknown";
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

function companionPathsResult(context: CompanionContext, wrapperBinPath: string) {
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
 * A wrapped repository lists this plugin in its own project config, so a
 * managed launch may load it twice; the marker keeps the second load inert.
 */
function hasCompanionPolicy(system: unknown[]): boolean {
  return system.map(readSystemText).join("\n").includes(COMPANION_POLICY_MARKER);
}

/**
 * Collapses the whole system prompt into a single entry. OpenCode sends each
 * `system[]` element as its own system message, and some self-hosted chat
 * templates (e.g. Qwen served via vLLM) reject any system message that is not
 * the very first one.
 */
function mergeCompanionSystem(system: unknown[], companion: string): string[] {
  if (hasCompanionPolicy(system)) return system.map(readSystemText);
  const parts: string[] = [];
  for (const text of [...system.map(readSystemText), companion]) {
    const trimmed = text.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }
  return parts.length > 0 ? [parts.join("\n\n")] : [];
}

/**
 * Registers guidance, compaction context, shell env, and `companion_paths`.
 * `env` is the launch environment the caller decided to trust; `{}` resolves
 * everything from the Projection Root.
 */
export async function registerCompanion(
  api: Context,
  context: CompanionContext,
  env: LaunchEnvironment = process.env,
  layerGuidance = "",
): Promise<void> {
  const guidance = loadGuidance(env, api.location.directory);
  if (!guidance) return;
  /** Reported, not thrown: the guardrails registered before this must stay live. */
  const wrapperBinPath = resolveWrapperBinPath(env);
  if (!wrapperBinPath) {
    console.error(`mate: ${missingRuntimeDirectoryMessage()}`);
    return;
  }

  const companion = buildSystemPrompt(context, guidance, wrapperBinPath, layerGuidance).join("\n");

  await api.session.hook("context", (event) => {
    const merged = mergeCompanionSystem(event.system, companion);
    event.system.splice(
      0,
      event.system.length,
      ...merged.map((text) => ({ type: "text" as const, text }) as never),
    );
  });

  await api.session.hook("compaction", (event) => {
    if (hasCompanionPolicy(event.system)) return;
    event.system.push({ type: "text", text: companion } as never);
  });

  await api.shell.hook("create.before", (event) => {
    applyCompanionShellEnv(context, event.env, wrapperBinPath, env);
  });

  await api.tool.transform((editor) => {
    editor.add({
      name: "companion_paths",
      description: `Return active ${context.frameworkName} companion framework and working repository paths.`,
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return companionPathsResult(context, wrapperBinPath);
      },
    });
  });
}
