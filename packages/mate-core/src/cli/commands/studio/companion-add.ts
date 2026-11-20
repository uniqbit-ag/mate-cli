import fs from "node:fs/promises";
import path from "node:path";

import { pathIsDirectory } from "../../../lib/fs-utils";
import {
  type CompanionRegistrationResult,
  registerConfiguredCompanion,
} from "../../../lib/orchestrator/companion-registration";
import type { StudioCompanionSource } from "../../../tools/setup/service";
import { deletableWithin } from "./companion-removal";

/** What adding a companion to Studio's registry came to; a refusal carries its reason as shown. */
export type CompanionAdd =
  | { ok: true; companionPath: string; existing: boolean }
  /** `tokenKey` is the `host/org` a Git token would unlock, when the clone was refused for one. */
  | { ok: false; reason: string; tokenKey?: string };

export interface CompanionAddDeps {
  /** The service that fetches companions by URL; a clone lands in its folder and only there is one removed. */
  source: StudioCompanionSource;
  register?: (companionPath: string) => Promise<CompanionRegistrationResult>;
  isDirectory?: (target: string) => Promise<boolean>;
  remove?: (target: string) => Promise<void>;
}

/**
 * Adds a companion by Git URL: the service fetches it into its folder, then it is registered.
 * A fresh fetch that is not a companion is removed again; a checkout that was already there is
 * only registered, never removed.
 */
export async function addCompanionByUrl(
  rawUrl: string,
  deps: CompanionAddDeps,
): Promise<CompanionAdd> {
  const register = deps.register ?? registerConfiguredCompanion;
  const remove = deps.remove ?? ((target: string) => fs.rm(target, { recursive: true }));
  const fetched = await deps.source.addByUrl(rawUrl);
  if (!fetched.ok) return fetched;
  const registered = await register(fetched.path);
  if (registered.ok) {
    return { ok: true, companionPath: registered.companionPath, existing: fetched.existing };
  }
  if (!fetched.existing && deletableWithin(fetched.path, deps.source.folder)) {
    await remove(fetched.path);
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
