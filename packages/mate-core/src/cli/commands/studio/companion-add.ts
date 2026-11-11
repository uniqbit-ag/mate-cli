import fs from "node:fs/promises";
import path from "node:path";

import { checkedCloneUrl } from "../../../lib/factory/clone-url";
import type { FactoryClient } from "../../../lib/factory/client";
import { gitKeyOf } from "../../../lib/factory/git-credential-store";
import { FactoryError } from "../../../lib/factory/ids";
import { pathIsDirectory } from "../../../lib/fs-utils";
import {
  type CompanionRegistrationResult,
  registerConfiguredCompanion,
} from "../../../lib/orchestrator/companion-registration";
import { deletableWithin } from "./companion-removal";

/** What adding a companion to Studio's registry came to; a refusal carries its reason as shown. */
export type CompanionAdd =
  | { ok: true; companionPath: string; existing: boolean }
  /** `tokenKey` is the `host/org` a Git token would unlock, when the clone was refused for one. */
  | { ok: false; reason: string; tokenKey?: string };

export interface CompanionAddDeps {
  client: Pick<FactoryClient, "cloneCompanion">;
  /** The factory's companions directory: a clone lands there and only there is a folder removed. */
  companionsDir: string;
  register?: (companionPath: string) => Promise<CompanionRegistrationResult>;
  isDirectory?: (target: string) => Promise<boolean>;
  remove?: (target: string) => Promise<void>;
}

/**
 * Adds a companion by Git URL: the broker clones it into the companions directory, then it is
 * registered. A fresh clone that is not a companion is removed again; a checkout that was
 * already there is only registered, never removed.
 */
export async function addCompanionByUrl(
  rawUrl: string,
  deps: CompanionAddDeps,
): Promise<CompanionAdd> {
  const register = deps.register ?? registerConfiguredCompanion;
  const remove = deps.remove ?? ((target: string) => fs.rm(target, { recursive: true }));
  let cloned: { path: string; existing: boolean };
  try {
    const url = checkedCloneUrl(rawUrl).url;
    cloned = await deps.client.cloneCompanion(url);
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    const key = error.code === "auth" ? gitKeyOf(rawUrl.trim()) : null;
    return {
      ok: false,
      reason: error.message,
      ...(key ? { tokenKey: `${key.host}/${key.org}` } : {}),
    };
  }
  const registered = await register(cloned.path);
  if (registered.ok) {
    return { ok: true, companionPath: registered.companionPath, existing: cloned.existing };
  }
  if (!cloned.existing && deletableWithin(cloned.path, deps.companionsDir)) {
    await remove(cloned.path);
    return { ok: false, reason: `That repository is not a companion: ${registered.reason}` };
  }
  return { ok: false, reason: registered.reason };
}

/** Adds a companion in place by its absolute path; nothing is copied or written inside it. */
export async function addCompanionByPath(
  rawPath: string,
  deps: Pick<CompanionAddDeps, "register" | "isDirectory">,
): Promise<CompanionAdd> {
  const register = deps.register ?? registerConfiguredCompanion;
  const isDirectory = deps.isDirectory ?? pathIsDirectory;
  const given = rawPath.trim();
  if (!path.isAbsolute(given)) {
    return { ok: false, reason: "Give the absolute path of the companion's folder." };
  }
  const companionPath = path.resolve(given);
  if (!(await isDirectory(companionPath))) {
    return { ok: false, reason: `${companionPath} is not a folder Studio can read.` };
  }
  const registered = await register(companionPath);
  if (!registered.ok) return { ok: false, reason: registered.reason };
  return {
    ok: true,
    companionPath: registered.companionPath,
    existing: registered.alreadyRegistered,
  };
}
