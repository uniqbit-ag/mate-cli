import fs from "node:fs/promises";
import path from "node:path";

import type {
  ManagedOutputEntry,
  ManagedOutputOwner,
  ManagedOutputRecorder,
  ManagedOutputReport,
} from "./plugin";

export interface ManagedOutputCollector {
  recorder: ManagedOutputRecorder;
  /** Entries inside the companion, deduplicated, as companion-relative POSIX paths. */
  report(): ManagedOutputReport;
}

export function createManagedOutputCollector(companionPath: string): ManagedOutputCollector {
  const entries: ManagedOutputEntry[] = [];
  return {
    recorder: { record: (entry) => entries.push(entry) },
    report() {
      const seen = new Set<string>();
      const report: ManagedOutputEntry[] = [];
      for (const entry of entries) {
        const relative = path.relative(companionPath, entry.path);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const posix = relative.split(path.sep).join("/");
        const key = `${entry.change}\0${entry.owner}\0${posix}`;
        if (seen.has(key)) continue;
        seen.add(key);
        report.push({ ...entry, path: posix });
      }
      return report;
    },
  };
}

/** Removes `target` and records it, only when it existed: a no-op removal claims nothing. */
export async function removeRecorded(
  target: string,
  owner: ManagedOutputOwner,
  recorder?: ManagedOutputRecorder,
): Promise<void> {
  const existed = await fs.lstat(target).then(
    () => true,
    () => false,
  );
  if (!existed) return;
  await fs.rm(target, { recursive: true, force: true });
  recorder?.record({ path: target, change: "removed", owner });
}
