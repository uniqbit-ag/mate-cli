// SessionStart activation for the globally installed Mate plugin.
//
// Runs in EVERY Claude session (the plugin is registered globally), so the
// non-Mate path must stay silent and fast: a single upward walk looking for
// the repo-local `.mate` registry, no global-registry read unless a pointer
// exists, no writes. Activation is trust-gated: a repo-local pointer only
// counts when `mate companion link` registered its companion in the user's
// Mate home — a crafted pointer committed to a cloned repository must never
// activate Mate against attacker-chosen paths.
import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../framework";
import { CompanionResolver } from "../lib/orchestrator/companion-resolver";
import { GlobalConfigStore } from "../lib/orchestrator/global-config-store";
import {
  findRepoLocalLinkedRepository,
  findRepoLocalRegistryFile,
} from "../lib/orchestrator/repo-local-registry";
import { mergeWithDefaults } from "../lib/orchestrator/config-store";
import type { FrameworkConfig } from "../lib/orchestrator/types";
import { buildCompanionGuidance } from "../playbooks/companion-guidance";
import type { HookEnv } from "./validate-artifact-path";

export interface ActivationOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const silent: ActivationOutcome = { exitCode: 0, stdout: "", stderr: "" };

function emit(payload: Record<string, unknown>): ActivationOutcome {
  return { exitCode: 0, stdout: JSON.stringify(payload) + "\n", stderr: "" };
}

function withContext(additionalContext: string, systemMessage?: string): ActivationOutcome {
  const payload: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  return emit(payload);
}

function loadCompanionConfig(companionPath: string): FrameworkConfig {
  try {
    const raw = fs.readFileSync(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "utf8",
    );
    return mergeWithDefaults((parse(raw) ?? {}) as FrameworkConfig);
  } catch {
    return mergeWithDefaults({} as FrameworkConfig);
  }
}

/**
 * Wrapper-bin path for policy text without requiring an active distribution:
 * sessions Mate did not spawn have no `createMate` run in-process, so fall
 * back from the materialized env to the module-relative packaged default.
 */
function resolveWrapperBinPath(env: HookEnv): string {
  if (env.MATE_WRAPPER_BIN_PATH) return env.MATE_WRAPPER_BIN_PATH;
  return path.resolve(import.meta.dirname, "../../wrappers/bin");
}

/** Read the packaged version lazily — a static package.json import needs a JSON import attribute under plain node. */
function packageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function mtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Cheap, no-write staleness probe (a few stats — never network git). `mate
 * sync --check` remains the precise authority; this catches the common cases:
 * settings never materialized, companion moved, capability config edited
 * after the last sync, missing marketplace scaffold. Mtime comparison was
 * chosen over content hashing for cost (design open question).
 */
export function probeWorkingRepoFreshness(
  workingRepoPath: string,
  companionPath: string,
): string | null {
  const settingsPath = path.join(workingRepoPath, ".claude", "settings.local.json");

  let settings: { env?: Record<string, string> } | null = null;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      env?: Record<string, string>;
    };
  } catch {
    return "materialized settings are missing";
  }

  if (path.resolve(settings?.env?.MATE_ARTIFACT_PATH ?? "") !== path.resolve(companionPath)) {
    return "materialized settings point at a different companion";
  }

  const settingsMtime = mtimeMs(settingsPath) ?? 0;
  const companionConfigMtime =
    mtimeMs(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml")) ?? 0;
  if (companionConfigMtime > settingsMtime) {
    return "companion configuration changed after the last sync";
  }

  // Path duplicated from companion-marketplace.ts on purpose: importing that
  // module would drag the whole setup-provider graph into every SessionStart.
  if (mtimeMs(path.join(companionPath, ".claude-plugin", "marketplace.json")) === null) {
    return "companion plugin marketplace has not been generated";
  }

  return null;
}

function syncNudge(reason: string): string {
  return [
    `Mate freshness: ${reason}.`,
    `Run \`${FRAMEWORK_NAME} sync\` in the working repository to refresh materialized configuration.`,
    "Note: MCP-level changes apply to the next session — restart the session after syncing to pick them up.",
  ].join(" ");
}

export interface ActivationDeps {
  globalConfigStore?: GlobalConfigStore;
}

export async function buildActivation(
  cwd: string,
  env: HookEnv,
  deps: ActivationDeps = {},
): Promise<ActivationOutcome> {
  // Fast no-op guard: non-Mate projects exit on this single upward walk.
  const found = await findRepoLocalRegistryFile(cwd);
  if (!found) return silent;

  const resolution = await new CompanionResolver(
    deps.globalConfigStore ?? new GlobalConfigStore(),
  ).resolveWithDiagnostics(found.repoRoot, { logFailures: false });

  if (!resolution.match) {
    if (resolution.failures.length === 0) return silent;
    const warning = [
      `${FRAMEWORK_NAME}: ignoring untrusted repo-local companion pointer(s):`,
      ...resolution.failures.map((failure) => `  ${failure.companionPath}`),
      `This repository is not linked on this machine; run \`${FRAMEWORK_NAME} companion link\` to trust it.`,
    ].join("\n");
    return emit({ systemMessage: warning });
  }

  if (resolution.ambiguousMatches.length > 1) {
    const candidates = resolution.ambiguousMatches
      .map((match) => `- ${path.basename(match.companionPath)} (${match.companionPath})`)
      .join("\n");
    return withContext(
      [
        "Multiple Mate companions are linked to this repository and none is pinned,",
        "so NO companion is active in this session (no guidance, skills, or MCP servers).",
        "Before any other work, use the AskUserQuestion tool to ask the user which",
        "companion to use, offering these candidates:",
        candidates,
        `Then run \`${FRAMEWORK_NAME} companion select <id>\` with their choice to pin it,`,
        "and tell the user to restart the session — the pinned companion only loads on the next session.",
      ].join("\n"),
      [
        `${FRAMEWORK_NAME}: multiple companions are linked to this repository and none is pinned — no companion is active.`,
        `Pick one with \`${FRAMEWORK_NAME} companion select <id>\` and restart, or answer the selection prompt in this session.`,
        "Candidates:",
        candidates,
      ].join("\n"),
    );
  }

  const companionPath = resolution.match.companionPath;
  const config = loadCompanionConfig(companionPath);
  const repository = (await findRepoLocalLinkedRepository(found.repoRoot)) ?? {
    id: resolution.match.repositoryId,
    path: found.repoRoot,
  };

  const policy = buildCompanionGuidance(
    {
      repository,
      allowedAgents: config.allowedAgents ?? [],
      companionPath,
      capabilities: config.capabilities ?? [],
      git: config.git,
    },
    { wrapperBinPath: resolveWrapperBinPath(env) },
  );

  const contextParts = [policy];
  const staleReason = probeWorkingRepoFreshness(found.repoRoot, companionPath);
  if (staleReason) contextParts.push(syncNudge(staleReason));

  const banner = `${FRAMEWORK_NAME} v${env.MATE_VERSION || packageVersion()}\n  repo:     ${repository.path}\n  ${FRAMEWORK_NAME}: ${companionPath}`;

  return withContext(contextParts.join("\n\n"), banner);
}

// Plugin-shim entry.
export async function run(): Promise<number> {
  const outcome = await buildActivation(process.cwd(), process.env);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  return outcome.exitCode;
}
