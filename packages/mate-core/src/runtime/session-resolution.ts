import fs from "node:fs";
import os from "node:os";

import {
  companionRegistryPath,
  globalConfigPath,
  readCompanionRegistrySync,
  readGlobalCompanionsSync,
} from "./companion-registry-read";
import { MATE_ENV } from "./env-names";
import { FRAMEWORK_NAME } from "./framework";
import { canonicalPath, physicalPath } from "./physical-path";
import {
  isCapabilityEnabled,
  policyDocument,
  readCompanionPolicy,
  type CompanionPolicy,
} from "./policy";
import { resolveProjection, type ResolvedProjection } from "./projection";

/**
 * Session Resolution: which Session Companion, Repository Link and Checkout a
 * session serves, for every Mate surface inside an agent session. The launch
 * environment decides first; otherwise a Projection Root counts only when its
 * companion is registered and its registry links the Checkout it was found in
 * (ADR-025). Synchronous and read-only: hooks cannot await, and nothing here
 * writes, repairs, projects, locks or runs Git.
 */

export type SessionEnv = Record<string, string | undefined>;

export interface SessionFlags {
  graphify: boolean;
  gitAutoMode: boolean;
  reactDoctor: boolean;
}

interface ServedCompanion {
  /** The companion's real path; empty for a launch whose environment names none. */
  companionPath: string;
  repositoryId: string;
  /** The Checkout the session serves; empty for a companion-scoped launch. */
  checkoutRoot: string;
  /** The companion's `framework.yaml`, read on first call and remembered. */
  policy(): CompanionPolicy;
  /** The `MATE_POLICY_JSON` document: a launch's own, else built from {@link policy}. */
  policyJson(): string;
  /** Capability flags: a launch's own, else read from {@link policy}. */
  flags(): SessionFlags;
}

export interface LaunchSession extends ServedCompanion {
  kind: "launch";
  /** `repository` when the environment names a repository path. */
  scope: "repository" | "companion";
  /** `MATE_WRAPPER_BIN_PATH`; empty when unset. */
  wrapperBinPath: string;
}

export interface ProjectionSession extends ServedCompanion {
  kind: "projection";
  /** The trusted projection as found: its `repoRoot` is the Projection Root, with the recorded stamp. */
  projection: ResolvedProjection;
}

export type SessionRefusalCode =
  | "companion-missing"
  | "companion-not-registered"
  | "repository-not-linked";

export interface SessionRefusal {
  code: SessionRefusalCode;
  /** One sentence naming the companion and why. */
  message: string;
  /** The companion the projection names, as written. */
  companionPath: string;
  /** Set when a file the check needs could not be read or parsed; it counts as no registration or link. */
  unreadable?: { file: string; error: string };
}

export interface NoSession {
  kind: "none";
  /** Set when a projection exists but is not trusted. */
  refusal?: SessionRefusal;
}

export type ResolvedSession = LaunchSession | ProjectionSession | NoSession;

export interface SessionResolutionDeps {
  /** The user's Mate configuration; defaults to `config.yaml` under `env.HOME`, else the process's home. */
  globalConfigPath?: string;
}

/** Any `MATE_*` variable present means a Mate launch configured this process. */
function hasLaunchEnvironment(env: SessionEnv): boolean {
  return Object.values(MATE_ENV).some((name) => env[name] !== undefined);
}

function remembered<T>(read: () => T): () => T {
  let value: { current: T } | undefined;
  return () => (value ??= { current: read() }).current;
}

function policyReaders(companionPath: string) {
  const policy = remembered(() => readCompanionPolicy(companionPath));
  return {
    policy,
    policyJson: remembered(() => policyDocument(policy())),
    flags: remembered(() => ({
      graphify: isCapabilityEnabled(policy(), "graphify"),
      gitAutoMode: policy().gitAutoMode,
      reactDoctor: isCapabilityEnabled(policy(), "react-doctor"),
    })),
  };
}

function launchSession(env: SessionEnv): LaunchSession {
  const companionPath = canonicalPath(env[MATE_ENV.companionPath] ?? "");
  const checkoutRoot = env[MATE_ENV.repositoryPath] ?? "";
  const policyJson = env[MATE_ENV.policyJson] ?? "{}";
  const flags: SessionFlags = {
    graphify: env[MATE_ENV.graphifyEnabled] === "1",
    gitAutoMode: env[MATE_ENV.gitAutoMode] === "1",
    reactDoctor: env[MATE_ENV.reactDoctorEnabled] === "1",
  };
  return {
    kind: "launch",
    scope: checkoutRoot ? "repository" : "companion",
    companionPath,
    repositoryId: env[MATE_ENV.repositoryId] ?? "",
    checkoutRoot,
    wrapperBinPath: env[MATE_ENV.wrapperBinPath] ?? "",
    policy: policyReaders(companionPath).policy,
    policyJson: () => policyJson,
    flags: () => flags,
  };
}

/** Not `fs.realpathSync`, which normalises `link/..` away first and would name a decoy folder. */
function realDirectory(target: string): string | null {
  try {
    const real = physicalPath(target);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

type Read<T> = { ok: true; value: T } | { ok: false; unreadable: { file: string; error: string } };

function readTrustFile<T>(file: string, read: () => T): Read<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return {
      ok: false,
      unreadable: { file, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function refused(
  code: SessionRefusalCode,
  companionPath: string,
  message: string,
  unreadable?: SessionRefusal["unreadable"],
): NoSession {
  return {
    kind: "none",
    refusal: { code, message, companionPath, ...(unreadable ? { unreadable } : {}) },
  };
}

/**
 * Matches the Checkout the projection was found in, not the one it claims: a
 * cloned repository's projection could name another linked Checkout.
 */
function projectionSession(
  env: SessionEnv,
  folder: string,
  deps: SessionResolutionDeps,
): ProjectionSession | NoSession {
  const projection = resolveProjection(folder);
  if (!projection?.companionPath) return { kind: "none" };
  const claimed = projection.companionPath;

  const companionPath = realDirectory(claimed);
  if (!companionPath) {
    return refused(
      "companion-missing",
      claimed,
      `the companion ${claimed} named by ${projection.repoRoot} does not exist.`,
    );
  }

  const configPath =
    deps.globalConfigPath ?? globalConfigPath(env.HOME || process.env.HOME || os.homedir());
  const registered = readTrustFile(configPath, () => readGlobalCompanionsSync(configPath));
  if (!registered.ok || !registered.value.some((entry) => physicalPath(entry) === companionPath)) {
    return refused(
      "companion-not-registered",
      claimed,
      `${companionPath} is not a companion registered in your ${FRAMEWORK_NAME} configuration.`,
      registered.ok ? undefined : registered.unreadable,
    );
  }

  const registryPath = companionRegistryPath(companionPath);
  const links = readTrustFile(registryPath, () => readCompanionRegistrySync(companionPath));
  const checkoutRoot = physicalPath(projection.repoRoot);
  if (
    !links.ok ||
    !links.value.some(
      (link) => link.id === projection.repositoryId && physicalPath(link.path) === checkoutRoot,
    )
  ) {
    return refused(
      "repository-not-linked",
      claimed,
      `the companion ${companionPath} does not link ${projection.repositoryId} at ${projection.repoRoot}.`,
      links.ok ? undefined : links.unreadable,
    );
  }

  return {
    kind: "projection",
    companionPath,
    repositoryId: projection.repositoryId,
    checkoutRoot,
    projection,
    ...policyReaders(companionPath),
  };
}

/**
 * The session `env` and `folder` belong to. With any `MATE_*` variable set the
 * answer is a launch from the environment alone, and no projection is read.
 */
export function resolveSession(
  env: SessionEnv,
  folder: string,
  deps: SessionResolutionDeps = {},
): ResolvedSession {
  if (hasLaunchEnvironment(env)) return launchSession(env);
  return projectionSession(env, folder, deps);
}

const REFUSAL_REASONS: Record<SessionRefusalCode, string> = {
  "companion-missing": "no longer exists",
  "companion-not-registered": "is not registered in your Mate configuration",
  "repository-not-linked": "does not link this Checkout",
};

/** The reason a refusal names, `unreadable` files included. */
export function sessionRefusalReason(refusal: SessionRefusal): string {
  const reason = refusal.unreadable
    ? `could not be checked, because ${refusal.unreadable.file} could not be read (${refusal.unreadable.error})`
    : REFUSAL_REASONS[refusal.code];
  return `${reason} (${refusal.code})`;
}

/** The one operator notice a session banner shows for a refused projection; never for the model. */
export function sessionRefusalNotice(refusal: SessionRefusal): string {
  return `${FRAMEWORK_NAME}: this folder's projection names a companion that ${sessionRefusalReason(refusal)}; plain sessions here run without Mate. Run \`${FRAMEWORK_NAME} doctor\`.`;
}

// ---------------------------------------------------------------------------
// `mate session context`
// ---------------------------------------------------------------------------

/** Readers reject any other version, so a changed reply fails closed instead of being misread. */
export const SESSION_CONTEXT_PROTOCOL = 1;

export type SessionContextErrorCode = "not-wrapped" | SessionRefusalCode;

export interface SessionContext {
  /** The companion's real path. */
  companionPath: string;
  /** The real path of the Checkout whose projection answered, which the trust check validated. */
  repositoryPath: string;
  repositoryId: string;
  /** The `MATE_POLICY_JSON` document a launch would carry for this companion. */
  policyJson: string;
}

export interface SessionContextError {
  code: SessionContextErrorCode;
  message: string;
}

export type SessionContextResult =
  | { ok: true; context: SessionContext }
  | { ok: false; error: SessionContextError };

/**
 * `mate session context`'s answer for `folder`. Ignores the launch
 * environment, since only a plain session asks. Throws when a file the trust
 * check needs cannot be read, so the command answers `internal` rather than a
 * refusal the user cannot act on.
 */
export function sessionContextFor(
  folder: string,
  deps: SessionResolutionDeps = {},
): SessionContextResult {
  const session = projectionSession({}, folder, deps);
  if (session.kind === "projection") {
    return {
      ok: true,
      context: {
        companionPath: session.companionPath,
        repositoryPath: session.checkoutRoot,
        repositoryId: session.repositoryId,
        policyJson: session.policyJson(),
      },
    };
  }
  const { refusal } = session;
  if (refusal?.unreadable) {
    throw new Error(`${refusal.unreadable.file}: ${refusal.unreadable.error}`);
  }
  return {
    ok: false,
    error: refusal
      ? { code: refusal.code, message: refusal.message }
      : {
          code: "not-wrapped",
          message: `no ${FRAMEWORK_NAME} projection covers ${folder}. Run \`${FRAMEWORK_NAME} wrap\` in the repository.`,
        },
  };
}

/** The one JSON object `mate session context --json` prints. */
export function sessionContextReply(result: SessionContextResult): Record<string, unknown> {
  return result.ok
    ? { protocol: SESSION_CONTEXT_PROTOCOL, ...result.context }
    : { protocol: SESSION_CONTEXT_PROTOCOL, error: result.error };
}
