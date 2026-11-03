export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  request?: (url: URL, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (message: string) => void;
}

/** Resolves once every package's `version` is on the npm registry; rejects naming the ones still missing. */
export function waitForPublishedPackages(
  packages: string[],
  version: string,
  options?: WaitOptions,
): Promise<void>;
