import path from "node:path";

import { checkoutRootOf } from "../../runtime/git-layout";
import { physicalPath } from "../../runtime/physical-path";
import type { WrapRuntime } from "../../runtime/runtime-document-manifest";
import { readWrapStateSync, WRAP_RUNTIMES } from "../../runtime/wrap-state";
import { GlobalConfigStore } from "./global-config-store";
import { registeredCheckoutOf } from "./registry-checkouts";
import {
  CompanionResolver,
  findRepoLocalLinkedRepository,
  readCompanionRegistry,
} from "./repository-link";
import type { LinkedRepository } from "./types";
import { projectWorkingRepositoryBestEffort } from "./working-repo-projection";

/**
 * Adoption as `mate session prepare`, a launch and `mate wrap` run it (design
 * Decisions 7 and 8): a look-up that writes nothing, so a caller can refuse
 * first, then the Checkout's link and Projection Root, each best-effort.
 */

export interface AdoptionLookup {
  companionPath: string;
  repositoryId: string;
  /** The runtimes the clone's Registered Checkout is wrapped for, in `WRAP_RUNTIMES` order. */
  runtimes: WrapRuntime[];
}

/** The runtimes the manifest at `checkout` records, in `WRAP_RUNTIMES` order. */
function wrappedAt(checkout: string): WrapRuntime[] {
  const { runtimes } = readWrapStateSync(checkout);
  return WRAP_RUNTIMES.filter((runtime) => runtimes.has(runtime));
}

/** The Registered Checkout of the entry `repositoryId` names, read without writing. */
export async function registeredCheckout(
  companionPath: string,
  repositoryId: string,
): Promise<string | null> {
  const { repos } = await readCompanionRegistry(companionPath).catch(() => ({ repos: [] }));
  const entry = repos.find((repo) => repo.id === repositoryId);
  return entry ? registeredCheckoutOf(entry) : null;
}

/**
 * The clone's entry for `folder` and its Registered Checkout's runtimes, with
 * no write: neither the resolver's self-heal nor its stale-pointer prune. Null
 * when no companion, or more than one, lists the folder's clone.
 */
export async function lookUpAdoption(
  folder: string,
  globalConfigStore: GlobalConfigStore = new GlobalConfigStore(),
): Promise<AdoptionLookup | null> {
  const { match, ambiguousMatches } = await new CompanionResolver(
    globalConfigStore,
  ).resolveWithDiagnostics(folder, { write: false });
  if (!match || ambiguousMatches.length > 1) return null;
  const registered = await registeredCheckout(match.companionPath, match.repositoryId);
  return { ...match, runtimes: registered ? wrappedAt(registered) : [] };
}

/**
 * Writes the Checkout's link (the resolver's self-heal) and its Projection
 * Root, outside the companion lock. A failed write warns, and the Checkout
 * still comes back as the repository, so the command that adopted it proceeds.
 */
export async function adoptCheckout(
  folder: string,
  lookup: AdoptionLookup,
  globalConfigStore: GlobalConfigStore = new GlobalConfigStore(),
): Promise<LinkedRepository> {
  await new CompanionResolver(globalConfigStore).resolveWithDiagnostics(folder);
  const repository = (await findRepoLocalLinkedRepository(folder)) ?? {
    id: lookup.repositoryId,
    path: checkoutRootOf(folder)?.root ?? path.resolve(folder),
  };
  await projectWorkingRepositoryBestEffort(lookup.companionPath, repository);
  return repository;
}

/**
 * Looks up and adopts `folder` in one step, for a command that wraps it
 * anyway (`mate wrap`). Null when no single companion lists its clone.
 */
export async function adoptNewCheckout(
  folder: string,
  globalConfigStore: GlobalConfigStore = new GlobalConfigStore(),
): Promise<LinkedRepository | null> {
  const lookup = await lookUpAdoption(folder, globalConfigStore);
  return lookup && adoptCheckout(folder, lookup, globalConfigStore);
}

export interface RegisteredWraps {
  /** The clone's Registered Checkout. */
  checkout: string;
  runtimes: WrapRuntime[];
}

/**
 * The clone's Registered Checkout and its wrapped runtimes, when that is
 * another Checkout than `repository` and is wrapped for any.
 */
export async function otherRegisteredWraps(
  companionPath: string,
  repository: LinkedRepository,
): Promise<RegisteredWraps | null> {
  const checkout = await registeredCheckout(companionPath, repository.id);
  if (!checkout || physicalPath(checkout) === physicalPath(repository.path)) return null;
  const runtimes = wrappedAt(checkout);
  return runtimes.length > 0 ? { checkout, runtimes } : null;
}

/**
 * The runtimes a prepare wraps `repository` for besides its own: none while
 * its manifest records a wrapped runtime, else those its Registered Checkout
 * is wrapped for (Decision 8). The Registered Checkout itself takes none.
 */
export async function inheritedWrapRuntimes(
  companionPath: string,
  repository: LinkedRepository,
): Promise<WrapRuntime[]> {
  if (wrappedAt(repository.path).length > 0) return [];
  return (await otherRegisteredWraps(companionPath, repository))?.runtimes ?? [];
}
