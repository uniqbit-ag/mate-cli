import { describe, expect, test } from "bun:test";

import type { StudioCompanionResponse } from "./payload";
import { createStudioSnapshotCache } from "./snapshot";

const ACME = "/companions/acme";

function payload(companionPath: string): StudioCompanionResponse {
  return { companionPath, changes: [], specs: [], topology: null, warnings: [] };
}

/** Collection the test releases by hand, so an overlap is observable. */
function deferred() {
  let release: (response: StudioCompanionResponse) => void = () => {};
  const promise = new Promise<StudioCompanionResponse>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (by: number) => {
      value += by;
    },
  };
}

describe("createStudioSnapshotCache", () => {
  test("collects once and serves the snapshot after that", async () => {
    const collected: string[] = [];
    const time = clock();
    const cache = createStudioSnapshotCache({
      assembleCompanionPayload: async (companionPath) => {
        collected.push(companionPath);
        return payload(companionPath);
      },
      now: time.now,
    });

    const first = await cache.read(ACME, false);
    time.advance(5_000);
    const second = await cache.read(ACME, false);

    expect(collected).toEqual([ACME]);
    expect(second).toBe(first);
    expect(second.collectedAt).toBe(1_000);
  });

  test("a refresh collects again and replaces the snapshot", async () => {
    let round = 0;
    const time = clock();
    const cache = createStudioSnapshotCache({
      assembleCompanionPayload: async () => {
        round += 1;
        return {
          companionPath: `${ACME}/${round}`,
          changes: [],
          specs: [],
          topology: null,
          warnings: [],
        };
      },
      now: time.now,
    });

    await cache.read(ACME, false);
    time.advance(2_000);
    const refreshed = await cache.read(ACME, true);
    const after = await cache.read(ACME, false);

    expect(round).toBe(2);
    expect(refreshed.collectedAt).toBe(3_000);
    expect(after).toBe(refreshed);
  });

  test("overlapping reads of one companion share a single collection", async () => {
    const pending = deferred();
    let calls = 0;
    const cache = createStudioSnapshotCache({
      assembleCompanionPayload: () => {
        calls += 1;
        return pending.promise;
      },
    });

    const first = cache.read(ACME, false);
    const second = cache.read(ACME, false);
    pending.release(payload(ACME));

    expect(await first).toBe(await second);
    expect(calls).toBe(1);
  });

  test("a failed collection leaves no snapshot behind", async () => {
    let calls = 0;
    const cache = createStudioSnapshotCache({
      assembleCompanionPayload: async () => {
        calls += 1;
        if (calls === 1) throw new Error("unreadable");
        return payload(ACME);
      },
    });

    await expect(cache.read(ACME, false)).rejects.toThrow("unreadable");
    expect((await cache.read(ACME, false)).response).toEqual(payload(ACME));
    expect(calls).toBe(2);
  });

  test("a slower earlier collection does not overwrite a newer snapshot", async () => {
    const slow = deferred();
    const time = clock();
    let calls = 0;
    const cache = createStudioSnapshotCache({
      assembleCompanionPayload: () => {
        calls += 1;
        return calls === 1 ? slow.promise : Promise.resolve(payload(`${ACME}/fresh`));
      },
      now: time.now,
    });

    const stale = cache.read(ACME, false);
    time.advance(1_000);
    const fresh = await cache.read(ACME, true);
    slow.release(payload(`${ACME}/stale`));
    await stale;

    expect((await cache.read(ACME, false)).collectedAt).toBe(fresh.collectedAt);
    expect((await cache.read(ACME, false)).response).toEqual(payload(`${ACME}/fresh`));
  });
});
