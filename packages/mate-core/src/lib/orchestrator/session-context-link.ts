import { FRAMEWORK_NAME } from "../../framework";
import { physicalPath } from "../../runtime/physical-path";
import {
  resolveSessionContext,
  sessionContextFailure,
  type SessionContext,
  type SessionContextResult,
} from "../../runtime/session-context";
import { GlobalConfigStore } from "./global-config-store";
import { readCompanionRegistry } from "./repository-link";

export interface SessionContextQueryDeps {
  configStore?: GlobalConfigStore;
}

/** Load errors propagate so the command answers `internal`, not "unregistered". */
async function isRegistered(companionPath: string, configStore: GlobalConfigStore) {
  const registered: unknown[] = await configStore.list();
  return registered.some(
    (entry) => typeof entry === "string" && physicalPath(entry) === companionPath,
  );
}

/**
 * Matches the checkout the projection was found in, not the one it claims: a
 * cloned repository's projection could name another linked checkout. Read
 * errors other than ENOENT propagate so the command answers `internal`.
 */
async function linksCheckout(context: SessionContext, checkoutRoot: string): Promise<boolean> {
  const registry = await readCompanionRegistry(context.companionPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { repos: [] };
    throw error;
  });
  const checkout = physicalPath(checkoutRoot);
  return registry.repos.some(
    (repo) => repo.id === context.repositoryId && physicalPath(repo.path) === checkout,
  );
}

/**
 * `mate session context`'s answer for `dir`. A projection is only a claim (a
 * cloned repository can carry one), and the answer decides which files a
 * Claude plugin hands to Claude, so the companion must be registered and its
 * registry must link this checkout by ID and path.
 */
export async function querySessionContext(
  dir: string,
  deps: SessionContextQueryDeps = {},
): Promise<SessionContextResult> {
  const result = resolveSessionContext(dir);
  if (!result.ok) return result;
  const { context, checkoutRoot } = result;

  if (!(await isRegistered(context.companionPath, deps.configStore ?? new GlobalConfigStore()))) {
    return sessionContextFailure(
      "companion-not-registered",
      `${context.companionPath} is not a companion registered in your ${FRAMEWORK_NAME} configuration.`,
    );
  }
  if (!(await linksCheckout(context, checkoutRoot))) {
    return sessionContextFailure(
      "repository-not-linked",
      `the companion ${context.companionPath} does not link ${context.repositoryId} at ${checkoutRoot}.`,
    );
  }
  return result;
}
