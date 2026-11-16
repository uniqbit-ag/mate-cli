import fs from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import { parseRemote, repositoryPath } from "../delivery/forge";
import { KeyedSerial } from "../factory/keyed-serial";

/**
 * The companion's machine-local list of Working Repositories a Workset may name: a
 * `repositories` list of clone URLs in `factory.local.yaml` at the companion's root. It is
 * excluded from Git locally and never shared, committed or published.
 */

export const FACTORY_LOCAL_FILE = "factory.local.yaml";

export interface LocalRepositories {
  /** Clone URLs in file order; empty when the file is missing or unusable. */
  urls: string[];
  /** Why the file is unusable, naming it and the entry; the list is then empty. */
  problem: string | null;
}

/** `org/repository` of a clone URL; null when it names none. */
export function repositoryIdentityOf(url: string): string | null {
  const parsed = parseRemote(url);
  return parsed ? repositoryPath(parsed) : null;
}

const fileOf = (companionPath: string) => path.join(companionPath, FACTORY_LOCAL_FILE);

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

const unusable = (reason: string) => ({
  data: {} as Record<string, unknown>,
  urls: [] as string[],
  problem: `${FACTORY_LOCAL_FILE} ${reason}`,
});

/** The parsed file, or its problem; `data` keeps every key, known or not. */
async function load(
  companionPath: string,
): Promise<{ data: Record<string, unknown>; urls: string[]; problem: string | null }> {
  let text: string;
  try {
    text = await fs.readFile(fileOf(companionPath), "utf8");
  } catch (error) {
    if (isMissing(error)) return { data: {}, urls: [], problem: null };
    return unusable(`could not be read: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = parse(text) ?? {};
  } catch {
    return unusable("is not valid YAML");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return unusable("must be a mapping with a `repositories` list");
  }
  const record = data as Record<string, unknown>;
  const entries = record.repositories ?? [];
  if (!Array.isArray(entries))
    return { ...unusable("`repositories` must be a list"), data: record };
  for (const entry of entries) {
    if (typeof entry !== "string" || repositoryIdentityOf(entry) === null) {
      return {
        ...unusable(`entry ${JSON.stringify(entry)} names no org/repository`),
        data: record,
      };
    }
  }
  return { data: record, urls: (entries as string[]).map((entry) => entry.trim()), problem: null };
}

export async function readLocalRepositories(companionPath: string): Promise<LocalRepositories> {
  const { urls, problem } = await load(companionPath);
  return { urls, problem };
}

/** One writer per file at a time, so two Studio requests cannot lose each other's change. */
const writers = new KeyedSerial();

async function save(
  companionPath: string,
  data: Record<string, unknown>,
  urls: string[],
): Promise<void> {
  const file = fileOf(companionPath);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, stringify({ ...data, repositories: urls }), "utf8");
  await fs.rename(temporary, file);
}

/**
 * Adds the first line to the companion's `.git/info/exclude` so the file leaves no tracked
 * change. Returns a warning when it could not, and nothing outside a Git repository.
 */
export async function excludeLocalFile(companionPath: string): Promise<string | null> {
  const git = path.join(companionPath, ".git");
  let stats;
  try {
    stats = await fs.stat(git);
  } catch {
    return null;
  }
  if (!stats.isDirectory()) {
    return `${FACTORY_LOCAL_FILE} could not be excluded from Git: the companion is a linked worktree`;
  }
  const exclude = path.join(git, "info", "exclude");
  try {
    const current = await fs.readFile(exclude, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return "";
      throw error;
    });
    if (current.split("\n").some((line) => line.trim() === FACTORY_LOCAL_FILE)) return null;
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await fs.writeFile(exclude, `${current}${separator}${FACTORY_LOCAL_FILE}\n`, "utf8");
    return null;
  } catch {
    return `${FACTORY_LOCAL_FILE} could not be added to .git/info/exclude; keep it out of commits yourself`;
  }
}

export interface LocalAdd {
  /** False when the repository was already listed. */
  added: boolean;
  warning: string | null;
}

/** Lists a clone URL; one already listed under the same `org/repository` is left as it is. */
export function addLocalRepository(companionPath: string, url: string): Promise<LocalAdd> {
  return writers.run(fileOf(companionPath), async () => {
    const { data, urls, problem } = await load(companionPath);
    if (problem) throw new Error(problem);
    const identity = repositoryIdentityOf(url);
    if (identity === null) throw new Error(`${url} names no org/repository`);
    if (urls.some((entry) => repositoryIdentityOf(entry) === identity)) {
      return { added: false, warning: null };
    }
    const warning = await excludeLocalFile(companionPath);
    await save(companionPath, data, [...urls, url.trim()]);
    return { added: true, warning };
  });
}

/** Removes the entry for `identity`; false when none was listed. */
export function removeLocalRepository(companionPath: string, identity: string): Promise<boolean> {
  return writers.run(fileOf(companionPath), async () => {
    const { data, urls, problem } = await load(companionPath);
    if (problem) throw new Error(problem);
    const kept = urls.filter((entry) => repositoryIdentityOf(entry) !== identity);
    if (kept.length === urls.length) return false;
    await save(companionPath, data, kept);
    return true;
  });
}
