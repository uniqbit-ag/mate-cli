import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import {
  MATE_ENV,
  readCompanionRuntimeContext,
  type CompanionRuntimeContext,
} from "../runtime/env";

// Session-runtime companion resolution for the globally registered OpenCode
// plugin. Deliberately read-only and dependency-light (no orchestrator
// imports — see runtime/import-isolation.test.ts): the plugin runs inside the
// agent host, must never write repo state, and must stay inert outside Mate
// repositories. Mirrors the CLI resolver's trust gate: a repo-local pointer
// only activates when its companion path is registered in the user's Mate
// home (written only by `mate companion link`).

const FRAMEWORK_NAME = "mate";

export interface ActivationCompanionConfig {
  allowedAgents: string[];
  capabilities: Array<{ name: string; [key: string]: unknown }>;
  git?: string;
}

export type OpenCodeActivation =
  | { status: "inert" }
  | { status: "untrusted"; warning: string }
  | { status: "ambiguous"; instruction: string; candidates: string[] }
  | {
      status: "active";
      context: CompanionRuntimeContext;
      config: ActivationCompanionConfig;
      wrapperBinPath: string;
    };

export interface OpenCodeActivationDeps {
  env?: Record<string, string | undefined>;
}

interface RepoLocalPointer {
  path: string;
  repositoryId: string;
}

interface RepoLocalData {
  repoRoot: string;
  pointers: RepoLocalPointer[];
  repository: { id: string; path: string } | null;
  selectedCompanionPath: string | null;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function registryPathFor(dir: string): string {
  return path.join(dir, `.${FRAMEWORK_NAME}`, "config", "registry.yaml");
}

/** Walk up from `directory` to the nearest repo-local registry; parse read-only. */
function readRepoLocalData(directory: string): RepoLocalData | null {
  let dir = path.resolve(directory);
  for (;;) {
    const registryPath = registryPathFor(dir);
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(registryPath, "utf8");
    } catch {
      /* keep walking up */
    }
    if (raw !== null) {
      try {
        const parsed = parse(raw) as {
          companions?: unknown;
          repository?: { id?: unknown; path?: unknown };
          selectedCompanionPath?: unknown;
        } | null;
        const pointers = Array.isArray(parsed?.companions)
          ? (parsed!.companions as Array<{ path?: unknown; repositoryId?: unknown }>)
              .filter((pointer) => typeof pointer?.path === "string")
              .map((pointer) => ({
                path: path.resolve(String(pointer.path)),
                repositoryId: String(pointer.repositoryId ?? ""),
              }))
          : [];
        const repository =
          parsed?.repository &&
          typeof parsed.repository.id === "string" &&
          typeof parsed.repository.path === "string"
            ? { id: parsed.repository.id, path: path.resolve(parsed.repository.path) }
            : null;
        return {
          repoRoot: dir,
          pointers,
          repository,
          selectedCompanionPath:
            typeof parsed?.selectedCompanionPath === "string"
              ? path.resolve(parsed.selectedCompanionPath)
              : null,
        };
      } catch {
        return null;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Companion paths trusted by `mate companion link` (the user's Mate home registry). */
function readTrustedCompanionPaths(env: Record<string, string | undefined>): Set<string> {
  const home = env.HOME || os.homedir();
  try {
    const raw = fs.readFileSync(path.join(home, `.${FRAMEWORK_NAME}`, "config.yaml"), "utf8");
    const parsed = parse(raw) as { companions?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.companions)) return new Set();
    return new Set(
      (parsed.companions as Array<{ path?: unknown }>)
        .filter((entry) => typeof entry?.path === "string")
        .map((entry) => path.resolve(String(entry.path))),
    );
  } catch {
    return new Set();
  }
}

function loadCompanionConfig(companionPath: string): ActivationCompanionConfig {
  try {
    const raw = fs.readFileSync(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "utf8",
    );
    const parsed = (parse(raw) ?? {}) as Partial<ActivationCompanionConfig>;
    return {
      allowedAgents: Array.isArray(parsed.allowedAgents) ? parsed.allowedAgents : [],
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
      ...(typeof parsed.git === "string" ? { git: parsed.git } : {}),
    };
  } catch {
    return { allowedAgents: [], capabilities: [] };
  }
}

function wrapperBinPathFor(env: Record<string, string | undefined>): string {
  if (env.MATE_WRAPPER_BIN_PATH) return env.MATE_WRAPPER_BIN_PATH;
  // Packaged default inside the installed mate-core package.
  return path.resolve(import.meta.dirname, "../../wrappers/bin");
}

function contextFromConfig(
  companionPath: string,
  repository: { id: string; path: string },
  config: ActivationCompanionConfig,
): CompanionRuntimeContext {
  const hasCapability = (name: string) =>
    config.capabilities.some((capability) => capability.name === name);
  return {
    frameworkName: FRAMEWORK_NAME,
    companionPath,
    repositoryPath: path.resolve(repository.path),
    repositoryId: repository.id,
    policyJson: JSON.stringify({ allowedAgents: config.allowedAgents }),
    graphifyEnabled: hasCapability("graphify"),
    gitAutoModeEnabled: config.git === "auto",
    reactDoctorEnabled: hasCapability("react-doctor"),
  };
}

/**
 * Resolve how the globally registered OpenCode plugin should behave for a
 * session directory. Launch env (deprecated shims / nested sessions) wins;
 * otherwise the repo-local `.mate` pointer resolves with the trust gate.
 * Guidance and capability gates always come from the companion's live
 * configuration, never from a launch payload.
 */
export async function resolveOpenCodeActivation(
  directory: string,
  deps: OpenCodeActivationDeps = {},
): Promise<OpenCodeActivation> {
  const env = deps.env ?? process.env;

  const envCompanionPath = env[MATE_ENV.companionPath];
  if (envCompanionPath && env[MATE_ENV.repositoryPath]) {
    const context = readCompanionRuntimeContext(env);
    return {
      status: "active",
      context,
      config: loadCompanionConfig(context.companionPath),
      wrapperBinPath: wrapperBinPathFor(env),
    };
  }

  const repoLocal = readRepoLocalData(directory);
  if (!repoLocal || repoLocal.pointers.length === 0) return { status: "inert" };

  const existing = repoLocal.pointers.filter((pointer) => isDirectory(pointer.path));
  if (existing.length === 0) return { status: "inert" };

  const trusted = readTrustedCompanionPaths(env);
  const trustedMatches: RepoLocalPointer[] = [];
  const untrustedPaths: string[] = [];
  const seen = new Set<string>();
  for (const pointer of existing) {
    if (seen.has(pointer.path)) continue;
    seen.add(pointer.path);
    if (trusted.has(pointer.path)) trustedMatches.push(pointer);
    else untrustedPaths.push(pointer.path);
  }

  if (trustedMatches.length === 0) {
    return {
      status: "untrusted",
      warning: [
        `${FRAMEWORK_NAME}: ignoring untrusted repo-local companion pointer(s):`,
        ...untrustedPaths.map((companionPath) => `  ${companionPath}`),
        `This repository is not linked on this machine; run \`${FRAMEWORK_NAME} companion link\` to trust it.`,
      ].join("\n"),
    };
  }

  let match = trustedMatches[0]!;
  if (trustedMatches.length > 1) {
    const pinned = repoLocal.selectedCompanionPath
      ? trustedMatches.find((pointer) => pointer.path === repoLocal.selectedCompanionPath)
      : undefined;
    if (!pinned) {
      const candidates = trustedMatches.map((pointer) => pointer.path);
      return {
        status: "ambiguous",
        candidates,
        instruction: [
          "Multiple Mate companions are linked to this repository and none is pinned,",
          "so NO companion is active in this session (no guidance, skills, or MCP servers).",
          "Before any other work, ask the user which companion to use. Candidates:",
          ...candidates.map(
            (companionPath) => `- ${path.basename(companionPath)} (${companionPath})`,
          ),
          `Then run \`${FRAMEWORK_NAME} companion select <id>\` with their choice to pin it.`,
          "Once pinned, the session reactivates automatically after your reply completes —",
          "the companion (guidance, skills, MCP servers) is live from the user's next message; no restart needed.",
        ].join("\n"),
      };
    }
    match = pinned;
  }

  const repository = repoLocal.repository ?? {
    id: match.repositoryId,
    path: repoLocal.repoRoot,
  };
  const config = loadCompanionConfig(match.path);

  return {
    status: "active",
    context: contextFromConfig(match.path, repository, config),
    config,
    wrapperBinPath: wrapperBinPathFor(env),
  };
}
