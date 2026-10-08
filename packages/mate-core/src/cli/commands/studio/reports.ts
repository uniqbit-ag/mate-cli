import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { COMPANION_DIGEST_PATTERN } from "./selection";

export const REPORT_LIMITS = {
  reports: 20,
  bytes: 50 * 1024 * 1024,
  ageMs: 7 * 24 * 60 * 60 * 1000,
  /** The bundled inlined Mermaid runtime alone is about 5.3 MiB. */
  uploadBytes: 10 * 1024 * 1024,
};

/** What listings expose: no paths, no content. */
export interface StoredReport {
  id: string;
  title: string;
  createdAt: number;
  bytes: number;
}

export interface ReportStoreOptions {
  /** Defaults to `~/.mate/studio/reports`. */
  root?: string;
  now?: () => number;
  limits?: Partial<typeof REPORT_LIMITS>;
}

export interface ReportStore {
  publish(companion: string, report: { title: string; html: string }): Promise<StoredReport>;
  /** Newest first. Never expires by age: only `publish` and `cleanup` remove. */
  list(companion: string): Promise<StoredReport[]>;
  /** The HTML of a stored report of any companion, or `null`. */
  read(id: string): Promise<string | null>;
  /** Removes expired reports from every companion. */
  cleanup(): Promise<void>;
}

const REPORT_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isReportId(value: string): boolean {
  return REPORT_ID_PATTERN.test(value);
}

function defaultReportRoot(): string {
  return path.join(os.homedir(), `.${FRAMEWORK_NAME}`, "studio", "reports");
}

function isEntry(value: unknown): value is StoredReport {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    isReportId(entry.id) &&
    typeof entry.title === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.bytes === "number"
  );
}

export function createReportStore(options: ReportStoreOptions = {}): ReportStore {
  const root = options.root ?? defaultReportRoot();
  const now = options.now ?? Date.now;
  const limits = { ...REPORT_LIMITS, ...options.limits };
  let queue: Promise<unknown> = Promise.resolve();

  /** One writer at a time: index read-modify-write must not interleave. */
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const directory = (companion: string) => {
    if (!COMPANION_DIGEST_PATTERN.test(companion)) throw new Error("invalid companion digest");
    return path.join(root, companion);
  };

  const readIndex = async (dir: string): Promise<StoredReport[]> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      return [];
    }
  };

  const writeIndex = async (dir: string, entries: StoredReport[]) => {
    const temporary = path.join(dir, `index.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(temporary, JSON.stringify(entries), "utf8");
    await rename(temporary, path.join(dir, "index.json"));
  };

  const remove = (dir: string, entry: StoredReport) =>
    rm(path.join(dir, `${entry.id}.html`), { force: true });

  /** Newest first; drops expired entries, then evicts oldest until both caps hold. */
  const prune = async (dir: string, entries: StoredReport[], keep?: string) => {
    const cutoff = now() - limits.ageMs;
    const kept: StoredReport[] = [];
    let bytes = 0;
    for (const entry of entries.toSorted((a, b) => b.createdAt - a.createdAt)) {
      const evictable =
        entry.createdAt < cutoff ||
        kept.length >= limits.reports ||
        bytes + entry.bytes > limits.bytes;
      if (evictable && entry.id !== keep) {
        await remove(dir, entry);
        continue;
      }
      kept.push(entry);
      bytes += entry.bytes;
    }
    return kept;
  };

  return {
    publish: (companion, report) =>
      serialized(async () => {
        const dir = directory(companion);
        await mkdir(dir, { recursive: true });
        const entry: StoredReport = {
          id: randomBytes(16).toString("hex"),
          title: report.title,
          createdAt: now(),
          bytes: Buffer.byteLength(report.html),
        };
        await writeFile(path.join(dir, `${entry.id}.html`), report.html, "utf8");
        const kept = await prune(dir, [entry, ...(await readIndex(dir))], entry.id);
        await writeIndex(dir, kept);
        return entry;
      }),
    list: (companion) =>
      serialized(async () =>
        (await readIndex(directory(companion))).toSorted((a, b) => b.createdAt - a.createdAt),
      ),
    read: (id) =>
      serialized(async () => {
        if (!isReportId(id)) return null;
        let companions: string[];
        try {
          companions = await readdir(root);
        } catch {
          return null;
        }
        for (const companion of companions) {
          if (!COMPANION_DIGEST_PATTERN.test(companion)) continue;
          const dir = path.join(root, companion);
          if (!(await readIndex(dir)).some((entry) => entry.id === id)) continue;
          try {
            return await readFile(path.join(dir, `${id}.html`), "utf8");
          } catch {
            return null;
          }
        }
        return null;
      }),
    cleanup: () =>
      serialized(async () => {
        let companions: string[];
        try {
          companions = await readdir(root);
        } catch {
          return;
        }
        for (const companion of companions) {
          if (!COMPANION_DIGEST_PATTERN.test(companion)) continue;
          const dir = path.join(root, companion);
          await writeIndex(dir, await prune(dir, await readIndex(dir)));
        }
      }),
  };
}
