import { describe, expect, it } from "bun:test";

import type { StudioInventory } from "./inventory";
import { companionDigest, parseStudioSelection, resolveCompanion } from "./selection";

const inventory: StudioInventory = {
  companions: [
    { path: "/home/dev/.mate/companions/acme-companion", health: "ready", pairings: [] },
    { path: "/home/dev/.mate/companions/beta-companion", health: "ready", pairings: [] },
  ],
};

describe("companionDigest", () => {
  it("is short, stable, and does not carry the path", () => {
    const digest = companionDigest("/home/dev/.mate/companions/acme-companion");
    expect(digest).toBe(companionDigest("/home/dev/.mate/companions/acme-companion"));
    expect(digest).toMatch(/^[0-9a-f]{10}$/);
    expect(digest).not.toContain("acme");
  });

  it("distinguishes two companions", () => {
    expect(companionDigest("/a/acme-companion")).not.toBe(companionDigest("/b/acme-companion"));
  });
});

describe("resolveCompanion", () => {
  it("resolves a digest back to its companion", () => {
    const digest = companionDigest(inventory.companions[1]!.path);
    expect(resolveCompanion(inventory, digest)?.path).toBe(inventory.companions[1]!.path);
  });

  it("selects nothing for an unresolvable digest", () => {
    expect(resolveCompanion(inventory, "deadbeef00")).toBeNull();
    expect(resolveCompanion(inventory, null)).toBeNull();
  });

  it("selects nothing when no companion is registered", () => {
    expect(resolveCompanion({ companions: [] }, companionDigest("/a"))).toBeNull();
  });
});

describe("parseStudioSelection", () => {
  it("reads the companion and the view", () => {
    const parsed = parseStudioSelection(
      new URL("http://localhost:1/?companion=abc123&view=workflow"),
    );
    expect(parsed).toEqual({
      companionDigest: "abc123",
      view: "workflow",
      refresh: false,
    });
  });

  it("falls back to the Dashboard for an absent or unknown view", () => {
    expect(parseStudioSelection(new URL("http://localhost:1/")).view).toBe("dashboard");
    expect(parseStudioSelection(new URL("http://localhost:1/?view=specs")).view).toBe("dashboard");
  });

  it("treats a blank parameter as unset", () => {
    expect(parseStudioSelection(new URL("http://localhost:1/?companion=%20"))).toEqual({
      companionDigest: null,
      view: "dashboard",
      refresh: false,
    });
  });

  it("reads a refresh only from the marker the refresh control writes", () => {
    expect(parseStudioSelection(new URL("http://localhost:1/?refresh=1")).refresh).toBe(true);
    expect(parseStudioSelection(new URL("http://localhost:1/?refresh=true")).refresh).toBe(false);
    expect(parseStudioSelection(new URL("http://localhost:1/?view=workflow")).refresh).toBe(false);
  });
});
