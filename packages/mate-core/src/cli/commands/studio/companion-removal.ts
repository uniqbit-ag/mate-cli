import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../../framework";
import { pathIsDirectory } from "../../../lib/fs-utils";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { isWithin } from "../../../runtime/physical-path";

export interface CompanionRemoval {
  companionPath: string;
  /** Whether a folder was deleted; a stale entry only leaves the registry. */
  deletedFolder: boolean;
}

export interface CompanionRemovalDeps {
  store?: Pick<GlobalConfigStore, "list" | "unregister">;
  isDirectory?: (target: string) => Promise<boolean>;
  readFile?: (target: string) => Promise<string>;
  remove?: (target: string) => Promise<void>;
  home?: string;
  /** When set, only a folder inside it is deleted; any other companion is only unregistered. */
  deleteWithin?: string;
}

/** A refusal Studio shows as it is; nothing was deleted or unregistered. */
export class CompanionRemovalError extends Error {}

/** Whether removal may delete the folder at `companionPath` given `deleteWithin`: strictly inside it, or anywhere without it. */
export function deletableWithin(companionPath: string, deleteWithin: string | undefined): boolean {
  if (deleteWithin === undefined) return true;
  const target = path.resolve(companionPath);
  const root = path.resolve(deleteWithin);
  return target !== root && isWithin(target, root);
}

/**
 * Deletes a registered Companion Repository's folder and drops its registry entry; not
 * recoverable. A registered path whose folder is already gone is only unregistered, as is a
 * companion outside `deleteWithin` when that is set: Studio never deletes a folder it did not
 * create. The
 * folder is deleted only when it carries a companion configuration, and never when it is
 * the filesystem root, the home folder or a folder holding the home folder.
 */
export async function deleteRegisteredCompanion(
  rawPath: string,
  deps: CompanionRemovalDeps = {},
): Promise<CompanionRemoval> {
  const store = deps.store ?? new GlobalConfigStore();
  const isDirectory = deps.isDirectory ?? pathIsDirectory;
  const readFile = deps.readFile ?? ((target: string) => fs.readFile(target, "utf8"));
  const remove =
    deps.remove ?? ((target: string) => fs.rm(target, { recursive: true, force: false }));
  const home = path.resolve(deps.home ?? os.homedir());
  const companionPath = path.resolve(rawPath);

  const registered = (await store.list()).some((entry) => path.resolve(entry) === companionPath);
  if (!registered)
    throw new CompanionRemovalError(`${companionPath} is not a registered companion.`);

  if (!(await isDirectory(companionPath)) || !deletableWithin(companionPath, deps.deleteWithin)) {
    await store.unregister(companionPath);
    return { companionPath, deletedFolder: false };
  }
  if (companionPath === path.parse(companionPath).root || isWithin(home, companionPath)) {
    throw new CompanionRemovalError(`${companionPath} holds the home folder; it is never deleted.`);
  }
  const config = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  let type: unknown;
  try {
    type = (parse(await readFile(config)) as { type?: unknown } | null)?.type;
  } catch {
    throw new CompanionRemovalError(
      `${companionPath} carries no readable companion configuration; it was not deleted.`,
    );
  }
  // A missing type predates the field and is a companion, as registration reads it.
  if (type !== undefined && type !== "companion") {
    throw new CompanionRemovalError(`${companionPath} is not a companion; it was not deleted.`);
  }
  await remove(companionPath);
  await store.unregister(companionPath);
  return { companionPath, deletedFolder: true };
}
