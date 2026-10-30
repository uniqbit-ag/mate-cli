#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 1000;

class MissingPackagesError extends Error {}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function isPublished(packageName, version, { request, now, remainingMs }) {
  const url = new URL(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
  );
  url.searchParams.set("_mate_registry_check", `${now()}-${Math.random()}`);

  let response;
  try {
    response = await request(url, {
      headers: {
        "cache-control": "no-cache, no-store, max-age=0",
        pragma: "no-cache",
      },
      signal: AbortSignal.timeout(remainingMs),
    });
  } catch (error) {
    throw new Error(`${packageName}@${version}: ${errorMessage(error)}`, { cause: error });
  }

  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`${packageName}@${version}: registry returned HTTP ${response.status}`);
  }

  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    throw new Error(
      `${packageName}@${version}: invalid registry response: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }

  if (metadata?.name !== packageName || metadata?.version !== version) {
    throw new Error(
      `${packageName}@${version}: invalid registry response (received ${metadata?.name ?? "no package"}@${metadata?.version ?? "no version"})`,
    );
  }
  return true;
}

export async function waitForPublishedPackages(
  packages,
  version,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    request = fetch,
    now = Date.now,
    sleep = delay,
    log = console.log,
  } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("registry wait timeout must be a positive number");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("registry wait interval must be a positive number");
  }

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let missing = [...new Set(packages)];
  const waitedFor = new Set();

  while (missing.length > 0) {
    const nextMissing = [];
    for (const packageName of missing) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        nextMissing.push(packageName, ...missing.slice(missing.indexOf(packageName) + 1));
        break;
      }

      if (await isPublished(packageName, version, { request, now, remainingMs })) {
        if (waitedFor.has(packageName)) {
          log(`Waited for ${packageName}@${version} for ${now() - startedAt}ms.`);
        }
      } else {
        waitedFor.add(packageName);
        nextMissing.push(packageName);
      }
    }

    missing = [...new Set(nextMissing)];
    if (missing.length === 0) return;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    for (const packageName of missing) {
      log(`Waiting for ${packageName}@${version} (${now() - startedAt}ms elapsed).`);
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }

  throw new MissingPackagesError(
    `Timed out after ${timeoutMs}ms waiting for ${missing.map((packageName) => `${packageName}@${version}`).join(", ")}.`,
  );
}

async function main() {
  const [version, ...packages] = process.argv.slice(2);
  if (!version || packages.length === 0) {
    process.stderr.write(
      "Usage: node wait-for-published-packages.mjs <version> <package> [package ...]\n",
    );
    return 2;
  }

  const timeoutMs = Number(process.env.MATE_REGISTRY_WAIT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const intervalMs = Number(process.env.MATE_REGISTRY_WAIT_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  try {
    await waitForPublishedPackages(packages, version, { timeoutMs, intervalMs });
    return 0;
  } catch (error) {
    const category =
      error instanceof MissingPackagesError ? "Missing packages" : "Registry/request error";
    process.stderr.write(`::error::${category}: ${errorMessage(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
