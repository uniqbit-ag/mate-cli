import { describe, expect, test } from "bun:test";

import { frictionFixture, frictionGroup } from "./fixture";
import { type FrictionFilters, selectFriction } from "./select-friction";

const DEFAULTS: FrictionFilters = { state: "open", sort: "repeats" };

describe("the order", () => {
  const repeated = frictionGroup({ maxPerSession: 4, lastSeen: "2026-11-03T09:00:00Z" });
  const recent = frictionGroup({
    fingerprint: "refusal:acme:today",
    maxPerSession: 1,
    lastSeen: "2026-11-10T09:00:00Z",
  });
  const view = frictionFixture({ groups: [repeated, recent] });

  test("most repeated in one session keeps the summary's order", () => {
    expect(selectFriction(view, DEFAULTS).groups).toEqual([repeated, recent]);
  });

  test("most recent puts the group last seen today first", () => {
    expect(selectFriction(view, { ...DEFAULTS, sort: "recent" }).groups).toEqual([
      recent,
      repeated,
    ]);
  });
});
