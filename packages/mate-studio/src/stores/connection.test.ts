import type { QueryClient } from "@tanstack/react-query";
import type { StudioConnectionState } from "@uniqbit/mate-core/studio";
import { afterEach, describe, expect, it } from "bun:test";

import { type ConnectionMonitor, createConnectionMonitor, useConnectionState } from "./connection";

/** Probes the test settles by hand, timers it fires by hand, and a page that can turn visible. */
function harness() {
  const pending: ((state: StudioConnectionState) => void)[] = [];
  const delays: number[] = [];
  let scheduled: (() => void) | null = null;
  let invalidated = 0;
  const target = new EventTarget();
  let visible = false;
  const monitor = createConnectionMonitor({
    queryClient: {
      invalidateQueries: async () => void (invalidated += 1),
    } as unknown as QueryClient,
    probe: () => new Promise((resolve) => pending.push(resolve)),
    target: target as unknown as Window,
    isVisible: () => visible,
    timers: {
      set: (run, ms) => {
        delays.push(ms);
        scheduled = run;
        return run;
      },
      clear: (handle) => {
        if (scheduled === handle) scheduled = null;
      },
    },
  });
  monitors.push(monitor);
  return {
    monitor,
    delays,
    target,
    probes: () => pending.length,
    invalidated: () => invalidated,
    /** Settles the latest probe and lets the monitor act on it. */
    async answer(state: StudioConnectionState) {
      pending.at(-1)!(state);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    fire() {
      const run = scheduled;
      scheduled = null;
      run?.();
    },
    show() {
      visible = true;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

const monitors: ConnectionMonitor[] = [];

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.dispose();
  useConnectionState.setState({ state: "online" });
});

describe("connection monitor", () => {
  it("probes once for concurrent failures", async () => {
    const page = harness();
    page.monitor.suspect();
    page.monitor.suspect();
    page.monitor.suspect();
    expect(page.probes()).toBe(1);
    await page.answer("online");
    page.monitor.suspect();
    expect(page.probes()).toBe(2);
  });

  it("stays online after a refusal the probe answers online", async () => {
    const page = harness();
    const heard: StudioConnectionState[] = [];
    page.monitor.subscribe((state) => heard.push(state));
    page.monitor.suspect();
    await page.answer("online");
    expect(page.monitor.state()).toBe("online");
    expect(heard).toEqual([]);
    expect(page.delays).toEqual([]);
  });

  it("takes the state from the probe and tells subscribers", async () => {
    const page = harness();
    const heard: StudioConnectionState[] = [];
    page.monitor.subscribe((state) => heard.push(state));
    page.monitor.suspect();
    await page.answer("signed-out");
    expect(useConnectionState.getState().state).toBe("signed-out");
    expect(heard).toEqual(["signed-out"]);
  });

  it("backs off from 1 s doubling to 30 s while offline", async () => {
    const page = harness();
    page.monitor.suspect();
    await page.answer("offline");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      page.fire();
      // oxlint-disable-next-line no-await-in-loop -- each probe follows the last
      await page.answer("offline");
    }
    expect(page.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("leaves the backoff to its timer when more requests fail", async () => {
    const page = harness();
    page.monitor.suspect();
    await page.answer("offline");
    page.monitor.suspect();
    expect(page.probes()).toBe(1);
  });

  it("probes at once when the page turns visible or the browser goes online", async () => {
    const page = harness();
    page.monitor.suspect();
    await page.answer("offline");
    page.target.dispatchEvent(new Event("visibilitychange"));
    expect(page.probes()).toBe(1);
    page.show();
    expect(page.probes()).toBe(2);
    await page.answer("offline");
    page.target.dispatchEvent(new Event("online"));
    expect(page.probes()).toBe(3);
  });

  it("refetches every query on recovery before telling subscribers", async () => {
    const page = harness();
    const heard: [StudioConnectionState, number][] = [];
    page.monitor.subscribe((state) => heard.push([state, page.invalidated()]));
    page.monitor.suspect();
    await page.answer("offline");
    page.fire();
    await page.answer("online");
    expect(page.monitor.state()).toBe("online");
    expect(heard).toEqual([
      ["offline", 0],
      ["online", 1],
    ]);
    page.monitor.suspect();
    await page.answer("offline");
    expect(page.delays.at(-1)).toBe(1_000);
  });

  it("stops calling a listener once unsubscribed", async () => {
    const page = harness();
    const heard: StudioConnectionState[] = [];
    const unsubscribe = page.monitor.subscribe((state) => heard.push(state));
    unsubscribe();
    page.monitor.suspect();
    await page.answer("offline");
    expect(heard).toEqual([]);
  });
});
