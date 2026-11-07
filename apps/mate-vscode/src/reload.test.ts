import { describe, expect, test } from "bun:test";

import { intervalSeconds, ReloadGate, type ReloadTarget } from "./reload";

function target(visible = true) {
  const state = {
    view: { visible },
    loading: undefined as Promise<void> | undefined,
    refreshed: 0,
    refresh() {
      state.refreshed++;
    },
  };
  return state satisfies ReloadTarget;
}

function gate(focused = true) {
  const clock = { now: 10_000, focused };
  return {
    clock,
    gate: new ReloadGate(
      () => clock.focused,
      () => clock.now,
    ),
  };
}

describe("ReloadGate", () => {
  test("refreshes only visible targets", () => {
    const { gate: reloads } = gate();
    const shown = target();
    const hidden = target(false);
    expect(reloads.reload([shown, hidden])).toEqual([shown]);
    expect([shown.refreshed, hidden.refreshed]).toEqual([1, 0]);
  });

  test("skips while the window is unfocused", () => {
    const { gate: reloads, clock } = gate(false);
    const shown = target();
    expect(reloads.reload([shown])).toEqual([]);
    clock.focused = true;
    expect(reloads.reload([shown])).toEqual([shown]);
  });

  test("skips while any target is still loading", () => {
    const { gate: reloads } = gate();
    const shown = target();
    const busy = target(false);
    busy.loading = new Promise(() => {});
    expect(reloads.reload([shown, busy])).toEqual([]);
    busy.loading = undefined;
    expect(reloads.reload([shown, busy])).toEqual([shown]);
  });

  test("keeps 3 seconds between reloads, including marked ones", () => {
    const { gate: reloads, clock } = gate();
    const shown = target();
    expect(reloads.reload([shown])).toHaveLength(1);
    clock.now += 2_999;
    expect(reloads.reload([shown])).toEqual([]);
    expect(reloads.wait()).toBe(1);
    clock.now += 1;
    expect(reloads.reload([shown])).toHaveLength(1);
    clock.now += 3_000;
    reloads.mark();
    expect(reloads.reload([shown])).toEqual([]);
    expect(shown.refreshed).toBe(2);
  });

  test("records no reload when nothing is visible", () => {
    const { gate: reloads } = gate();
    expect(reloads.reload([target(false)])).toEqual([]);
    expect(reloads.wait()).toBe(0);
  });
});

describe("intervalSeconds", () => {
  test("defaults to 30, keeps 0 off, and raises 1–4 to 5", () => {
    expect(intervalSeconds(undefined)).toBe(30);
    expect(intervalSeconds(-1)).toBe(30);
    expect(intervalSeconds("10")).toBe(30);
    expect(intervalSeconds(0)).toBe(0);
    expect(intervalSeconds(1)).toBe(5);
    expect(intervalSeconds(4.5)).toBe(5);
    expect(intervalSeconds(60)).toBe(60);
  });
});
