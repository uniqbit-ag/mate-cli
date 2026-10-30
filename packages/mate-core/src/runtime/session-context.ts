import fs from "node:fs";

import { FRAMEWORK_NAME } from "./framework";
import { physicalPath } from "./physical-path";
import { policyDocument, readCompanionPolicy } from "./policy";
import { resolveProjection } from "./projection";

/** Readers reject any other version, so a changed reply fails closed instead of being misread. */
export const SESSION_CONTEXT_PROTOCOL = 1;

export type SessionContextErrorCode =
  | "not-wrapped"
  | "companion-missing"
  | "companion-not-registered"
  | "repository-not-linked";

export interface SessionContext {
  /** The companion's real path. */
  companionPath: string;
  /** The real path of the checkout whose projection answered, which the link check validates. */
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
  | {
      ok: true;
      context: SessionContext;
      /** Where the projection was found; its own `repositoryPath` is only a claim, so the caller checks this against the registry. */
      checkoutRoot: string;
    }
  | { ok: false; error: SessionContextError };

export function sessionContextFailure(
  code: SessionContextErrorCode,
  message: string,
): SessionContextResult {
  return { ok: false, error: { code, message } };
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

/**
 * Read-only: never repairs, prunes, projects or locks, and ignores the launch
 * environment, since only a session without one asks. Does not judge trust;
 * the caller checks the companion's registration before reporting it.
 */
export function resolveSessionContext(dir: string): SessionContextResult {
  const projection = resolveProjection(dir);
  if (!projection?.companionPath) {
    return sessionContextFailure(
      "not-wrapped",
      `no ${FRAMEWORK_NAME} projection covers ${dir}. Run \`${FRAMEWORK_NAME} wrap\` in the repository.`,
    );
  }

  const companionPath = realDirectory(projection.companionPath);
  if (!companionPath) {
    return sessionContextFailure(
      "companion-missing",
      `the companion ${projection.companionPath} named by ${projection.repoRoot} does not exist.`,
    );
  }

  const policy = readCompanionPolicy(companionPath);
  return {
    ok: true,
    checkoutRoot: projection.repoRoot,
    context: {
      companionPath,
      repositoryPath: realDirectory(projection.repoRoot) ?? projection.repoRoot,
      repositoryId: projection.repositoryId,
      policyJson: policyDocument(policy),
    },
  };
}

/** The one JSON object `mate session context --json` prints. */
export function sessionContextReply(result: SessionContextResult): Record<string, unknown> {
  return result.ok
    ? { protocol: SESSION_CONTEXT_PROTOCOL, ...result.context }
    : { protocol: SESSION_CONTEXT_PROTOCOL, error: result.error };
}
