import { execFile } from "node:child_process";

import type { UsageObservation } from "./records";
import type { UsageScope } from "./scope";
import type { UsageSource, UsageSourceName, UsageSourceStatus } from "./types";

export interface UsageCollection {
  observations: UsageObservation[];
  sources: UsageSource[];
}

export function sourceResult(
  scope: UsageScope,
  name: UsageSourceName,
  status: UsageSourceStatus,
  observations: UsageObservation[] = [],
  detail?: string,
  partial = false,
): UsageCollection {
  return {
    observations,
    sources: scope.repositories.map((repository) => {
      const note = repository.available ? detail : "Linked checkout is unavailable";
      return {
        repositoryId: repository.id,
        name,
        status: repository.available ? status : "unavailable",
        ...(note ? { detail: note } : {}),
        ...(partial ? { partial: true } : {}),
      };
    }),
  };
}

export type UsageCommand = (
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<string>;

export const runUsageCommand: UsageCommand = (command, args, cwd, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        signal,
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

/** How long an aborted job may take to return the records it read before its deadline. */
const ABORT_GRACE_MS = 1_000;

/** Four workers; each job gets a real cancellation signal and its own deadline. */
export async function collectUsageJobs(
  jobs: {
    run: (signal: AbortSignal) => Promise<UsageCollection>;
    failed: (status: "timeout" | "error") => UsageCollection;
  }[],
  timeoutMs = 15_000,
): Promise<UsageCollection[]> {
  const results: UsageCollection[] = Array.from({ length: jobs.length });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index]!;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<UsageCollection>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          grace = setTimeout(() => resolve(job.failed("timeout")), ABORT_GRACE_MS);
        }, timeoutMs);
      });
      try {
        // oxlint-disable-next-line no-await-in-loop -- one bounded job per worker
        results[index] = await Promise.race([job.run(controller.signal), deadline]);
      } catch {
        results[index] = job.failed(controller.signal.aborted ? "timeout" : "error");
      } finally {
        clearTimeout(timer!);
        clearTimeout(grace);
        controller.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  return results;
}
