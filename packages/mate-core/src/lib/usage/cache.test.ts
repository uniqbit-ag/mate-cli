import { expect, test } from "bun:test";

import { aggregateUsage } from "./aggregate";
import { createUsageCache } from "./cache";
import type { UsageScope } from "./scope";
import { sourceResult } from "./source";

const scope = (root: string, fingerprint = "acme"): UsageScope => ({
  companionPath: root,
  companionId: root,
  capabilities: [],
  fingerprint,
  repositories: [],
});

test("coalesces reads/refreshes and isolates companions, periods and inventory", async () => {
  let calls = 0;
  let fingerprint = "acme";
  const cache = createUsageCache({
    now: () => new Date("2026-11-07T12:00:00Z"),
    scope: async (root) => scope(root, fingerprint),
    collect: async (selected, window) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return aggregateUsage(selected, window, [], window.start);
    },
  });
  await Promise.all([
    cache.read("/acme/one", { days: 7 }),
    cache.read("/acme/one", { days: 7 }),
    cache.read("/acme/one", { days: 7, refresh: true }),
  ]);
  expect(calls).toBe(1);
  await cache.read("/acme/one", { days: 7 });
  expect(calls).toBe(1);
  await cache.read("/acme/two", { days: 7 });
  await cache.read("/acme/one", { days: 30 });
  fingerprint = "acme-new-link";
  await cache.read("/acme/one", { days: 7 });
  expect(calls).toBe(4);
});

test("failed refresh retains prior snapshot; unavailable scope never serves other data", async () => {
  let failed = false;
  const cache = createUsageCache({
    scope: async (root) => {
      if (root === "/acme/missing") throw new Error("private path");
      return scope(root);
    },
    collect: async (selected, window) => {
      if (failed) throw new Error("private error");
      return aggregateUsage(
        selected,
        window,
        [sourceResult(selected, "claude", "unavailable")],
        window.start,
      );
    },
  });
  const first = await cache.read("/acme/one", { days: 7 });
  failed = true;
  const refresh = await cache.read("/acme/one", { days: 7, refresh: true });
  expect(refresh.snapshot).toEqual(first.snapshot);
  expect(refresh.error?.code).toBe("COLLECTION_FAILED");
  expect(JSON.stringify(refresh)).not.toContain("private error");
  expect((await cache.read("/acme/missing", { days: 7 })).snapshot).toBeNull();
});

test("a transient scope failure keeps the previous snapshot for that companion and period", async () => {
  let unreadable = false;
  const cache = createUsageCache({
    scope: async (root) => {
      if (unreadable) throw new Error("private path");
      return scope(root);
    },
    collect: async (selected, window) => aggregateUsage(selected, window, [], window.start),
  });
  const first = await cache.read("/acme/one", { days: 7 });
  unreadable = true;
  const stale = await cache.read("/acme/one", { days: 7, refresh: true });
  expect(stale.snapshot).toEqual(first.snapshot);
  expect(stale.error?.code).toBe("COMPANION_UNRESOLVED");
  expect((await cache.read("/acme/one", { days: 30 })).snapshot).toBeNull();
  expect((await cache.read("/acme/two", { days: 7 })).snapshot).toBeNull();
});

test("evicts least-recent snapshots and retries a synchronous collector failure", async () => {
  let calls = 0;
  const cache = createUsageCache({
    limit: 1,
    scope: async (root) => scope(root),
    collect: (selected, window) => {
      calls++;
      if (calls === 1) throw new Error("synthetic");
      return Promise.resolve(aggregateUsage(selected, window, [], window.start));
    },
  });
  expect((await cache.read("/acme/one", { days: 7 })).error).not.toBeNull();
  expect((await cache.read("/acme/one", { days: 7 })).error).toBeNull();
  await cache.read("/acme/two", { days: 7 });
  await cache.read("/acme/one", { days: 7 });
  expect(calls).toBe(4);
});
