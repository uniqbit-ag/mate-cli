import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { pathIsDirectory } from "../fs-utils";
import { runOpenSpec } from "../openspec-cli";

/**
 * The Companion Repository as an OpenSpec store. OpenSpec reports the Working
 * Repository as an edit root only when the CLI runs inside a project whose
 * `openspec/config.yaml` declares a registered store, so the store has to be
 * registered before any pointer may name it.
 *
 * Registration is checked by reading OpenSpec's registry file, never by
 * spawning: the check runs on every session refresh. The CLI is spawned only to
 * register, which OpenSpec answers authoritatively.
 */

/** OpenSpec's one id grammar, shared by store and change ids. */
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const STORE_METADATA_FILE = path.join(".openspec-store", "store.yaml");

/** Injectable so the suite never touches the developer's registry; the CLI is `openSpecCliDeps`. */
export const openSpecStoreDeps = {
  env: (): NodeJS.ProcessEnv => process.env,
  platform: (): NodeJS.Platform => process.platform,
  homedir: (): string => os.homedir(),
};

export type StoreRegistrationCheck =
  | { state: "registered" }
  | { state: "absent" }
  | { state: "conflict"; path: string }
  | { state: "unreadable" };

export type StoreRegistration =
  | { state: "written" | "current"; id: string }
  | { state: "skipped"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function canonicalPath(candidate: string): Promise<string> {
  return fs.realpath(candidate).catch(() => path.resolve(candidate));
}

function sanitizeStoreId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The id a registration already recorded beside the companion, else the
 * companion folder name made into a valid id. Machine-local on purpose: no
 * artifact embeds it, and a committed one would collide across clones.
 */
export async function deriveStoreId(companionPath: string): Promise<string> {
  const metadata = await fs
    .readFile(path.join(companionPath, STORE_METADATA_FILE), "utf8")
    .then((content) => parseYaml(content) as unknown)
    .catch(() => null);
  if (isRecord(metadata) && typeof metadata.id === "string" && KEBAB_ID.test(metadata.id)) {
    return metadata.id;
  }
  const folder = path.basename(path.resolve(companionPath));
  const id = sanitizeStoreId(folder);
  if (!KEBAB_ID.test(id)) {
    throw new Error(`cannot derive an OpenSpec store id from the companion folder "${folder}"`);
  }
  return id;
}

/** Mirrors OpenSpec's `getGlobalDataDir`, so Mate reads the registry OpenSpec writes. */
export function openSpecDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homedir: string,
): string {
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, "openspec");
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA ?? path.join(homedir, "AppData", "Local"), "openspec");
  }
  return path.join(homedir, ".local", "share", "openspec");
}

function registryPath(): string {
  return path.join(
    openSpecDataDir(
      openSpecStoreDeps.env(),
      openSpecStoreDeps.platform(),
      openSpecStoreDeps.homedir(),
    ),
    "stores",
    "registry.yaml",
  );
}

/** Read-only: what the registry says about `id`, compared by canonical path. */
export async function checkStoreRegistration(
  companionPath: string,
  id: string,
): Promise<StoreRegistrationCheck> {
  let content: string;
  try {
    content = await fs.readFile(registryPath(), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "unreadable" };
  }
  let registry: unknown;
  try {
    registry = parseYaml(content);
  } catch {
    return { state: "unreadable" };
  }
  if (!isRecord(registry) || !isRecord(registry.stores)) return { state: "unreadable" };
  const entry = registry.stores[id];
  if (entry === undefined) return { state: "absent" };
  const localPath =
    isRecord(entry) && isRecord(entry.backend) ? entry.backend.local_path : undefined;
  if (typeof localPath !== "string") return { state: "unreadable" };
  return (await canonicalPath(localPath)) === (await canonicalPath(companionPath))
    ? { state: "registered" }
    : { state: "conflict", path: localPath };
}

/**
 * Registers the companion when the registry lacks it. A conflicting id fails
 * rather than silently picking another one; a missing bundled CLI, or a
 * companion that is no OpenSpec root, is skipped.
 */
export async function ensureStoreRegistration(companionPath: string): Promise<StoreRegistration> {
  const companion = await canonicalPath(companionPath);
  if (!(await pathIsDirectory(path.join(companion, "openspec")))) {
    return { state: "skipped", reason: `${companion} is not an OpenSpec root` };
  }
  const id = await deriveStoreId(companion);
  const check = await checkStoreRegistration(companion, id);
  if (check.state === "registered") return { state: "current", id };
  if (check.state === "conflict") {
    throw new Error(`OpenSpec store id "${id}" is already registered at ${check.path}`);
  }

  const run = await runOpenSpec(["store", "register", companion, "--id", id, "--yes"], {
    cwd: companion,
    env: openSpecStoreDeps.env(),
    timeout: 30_000,
  });
  if (run.missing) return { state: "skipped", reason: run.stderr };
  if (run.code !== 0) {
    const output = (run.stderr || run.stdout).trim() || `exit code ${run.code ?? "unknown"}`;
    throw new Error(`openspec store register failed: ${output}`);
  }
  return { state: "written", id };
}
