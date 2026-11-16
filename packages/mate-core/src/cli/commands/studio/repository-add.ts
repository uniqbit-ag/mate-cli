import path from "node:path";

import { workingRepoGit } from "../../../lib/delivery/branches";
import { checkedCloneUrl } from "../../../lib/factory/clone-url";
import type { FactoryClient } from "../../../lib/factory/client";
import { gitKeyOf } from "../../../lib/factory/git-credential-store";
import { FactoryError } from "../../../lib/factory/ids";
import { pathIsDirectory } from "../../../lib/fs-utils";
import { addLocalRepository, removeLocalRepository } from "../../../lib/workset/factory-local";
import { linkedRepositoryIdentities } from "../../../lib/workset/repositories";

export type RepositoryAddInput = { kind: "url"; url: string } | { kind: "path"; path: string };

/** What adding a Working Repository came to; a refusal carries its reason as shown. */
export type RepositoryAddResult =
  | { ok: true; identity: string; existing: boolean; warning?: string }
  /** `tokenKey` is the `host/org` a Git token would unlock, when the check was refused for one. */
  | { ok: false; reason: string; tokenKey?: string };

export interface RepositoryAddDeps {
  client: Pick<FactoryClient, "checkRemote">;
  env?: NodeJS.ProcessEnv;
  isDirectory?: (target: string) => Promise<boolean>;
  /** The `origin` URL of a checkout; null when it has none or is no checkout. */
  originOf?: (checkout: string) => Promise<string | null>;
}

const refusal = (reason: string): RepositoryAddResult => ({ ok: false, reason });

/** The clone URL a local checkout stands for: its `origin`. */
async function urlOfCheckout(
  rawPath: string,
  deps: RepositoryAddDeps,
): Promise<{ url: string } | RepositoryAddResult> {
  const given = rawPath.trim();
  if (!path.isAbsolute(given)) return refusal("Give the absolute path of the checkout.");
  const checkout = path.resolve(given);
  if (!(await (deps.isDirectory ?? pathIsDirectory)(checkout))) {
    return refusal(`${checkout} is not a folder Studio can read.`);
  }
  const origin = await (deps.originOf ?? ((dir) => workingRepoGit(dir).remoteUrl()))(checkout);
  if (!origin) return refusal(`${checkout} is not a Git checkout with an origin.`);
  return { url: origin };
}

/**
 * Adds a Working Repository to the companion's `factory.local.yaml`, by Git URL or from a local
 * checkout's `origin`. One already offered from any source is reported and left alone; a remote
 * that does not answer adds nothing, and a refusal for authentication names the Git token that
 * would unlock it.
 */
export async function addRepository(
  companionPath: string,
  input: RepositoryAddInput,
  deps: RepositoryAddDeps,
): Promise<RepositoryAddResult> {
  let url: string;
  if (input.kind === "path") {
    const found = await urlOfCheckout(input.path, deps);
    if (!("url" in found)) return found;
    url = found.url;
  } else {
    url = input.url;
  }

  let remote;
  try {
    remote = checkedCloneUrl(url);
  } catch (error) {
    if (error instanceof FactoryError) return refusal(error.message);
    throw error;
  }
  if ((await linkedRepositoryIdentities(companionPath, deps.env)).includes(remote.identity)) {
    return { ok: true, identity: remote.identity, existing: true };
  }

  try {
    await deps.client.checkRemote(remote.url);
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    const key = error.code === "auth" ? gitKeyOf(remote.url) : null;
    return {
      ok: false,
      reason: error.message,
      ...(key ? { tokenKey: `${key.host}/${key.org}` } : {}),
    };
  }

  try {
    const { warning } = await addLocalRepository(companionPath, remote.url);
    return {
      ok: true,
      identity: remote.identity,
      existing: false,
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    return refusal(error instanceof Error ? error.message : "The repository was not added.");
  }
}

/** Removes an entry of `factory.local.yaml`; a linked or environment repository is not one. */
export async function removeRepository(
  companionPath: string,
  identity: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (await removeLocalRepository(companionPath, identity)) return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Nothing was removed." };
  }
  return {
    ok: false,
    reason: `${identity} is not in the list Studio manages; a linked or configured repository is removed where it was set.`,
  };
}
