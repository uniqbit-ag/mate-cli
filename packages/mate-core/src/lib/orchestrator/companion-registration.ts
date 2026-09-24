import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { GlobalConfigStore } from "./global-config-store";
import type { FrameworkType } from "./types";

export type CompanionRegistrationResult =
  | { ok: true; companionPath: string; alreadyRegistered: boolean }
  | { ok: false; companionPath: string; reason: string };

export interface RegisterConfiguredCompanionDeps {
  globalConfigStore?: Pick<GlobalConfigStore, "list" | "register">;
  readFile?: typeof fs.readFile;
}

function configPathFor(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
}

/**
 * Registration for a Companion Repository that already carries its own
 * configuration: never presents a selection, never reads stdin, and never
 * writes the companion's configuration — only the global registry entry.
 */
export async function registerConfiguredCompanion(
  rawCompanionPath: string,
  deps: RegisterConfiguredCompanionDeps = {},
): Promise<CompanionRegistrationResult> {
  const companionPath = path.resolve(rawCompanionPath);
  const readFile = deps.readFile ?? fs.readFile;
  const store = deps.globalConfigStore ?? new GlobalConfigStore();

  let raw: string;
  try {
    raw = await readFile(configPathFor(companionPath), "utf8");
  } catch {
    return {
      ok: false,
      companionPath,
      reason: `${companionPath} carries no companion configuration (${path.join(`.${FRAMEWORK_NAME}`, "config", "framework.yaml")} is missing); there is nothing to register.`,
    };
  }

  let declaredType: FrameworkType | undefined;
  try {
    declaredType = (parse(raw) as { type?: FrameworkType } | null)?.type;
  } catch {
    return {
      ok: false,
      companionPath,
      reason: `${companionPath} carries an unreadable companion configuration; there is nothing to register.`,
    };
  }

  /** A missing type predates the field and is a companion; anything else is not one. */
  if (declaredType !== undefined && declaredType !== "companion") {
    return {
      ok: false,
      companionPath,
      reason: `${companionPath} is a "${declaredType}" framework, not a companion; there is nothing to register.`,
    };
  }

  const alreadyRegistered = (await store.list()).some(
    (entry) => path.resolve(entry) === companionPath,
  );
  await store.register(companionPath);

  return { ok: true, companionPath, alreadyRegistered };
}
