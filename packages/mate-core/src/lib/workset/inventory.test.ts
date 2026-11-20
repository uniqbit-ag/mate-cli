import { describe, expect, test } from "bun:test";

import { buildInventory } from "./inventory";
import type { WorksetRecord } from "./record";

const record = (id: string, changes: string[] = [], extra: Partial<WorksetRecord> = {}) => ({
  id,
  title: id,
  intent: `${id} intent`,
  repositories: ["acme/web"],
  changes,
  stage: "clarify-intent" as const,
  createdAt: "2026-11-01T00:00:00.000Z",
  extra: {},
  ...extra,
});

const scope = (name: string) => ({ name, repositories: ["acme/web"] });
const links = (name: string, dependsOn: string[] = [], branches: string[] = []) => ({
  name,
  dependsOn,
  branches,
});

describe("the Work inventory", () => {
  test("ideas, a single change and dependent slices; reading writes nothing", () => {
    const inventory = buildInventory({
      listing: { worksets: [record("acme-idea")], problems: [] },
      activeChanges: [scope("acme-fix"), scope("acme-api"), scope("acme-ui")],
      links: [links("acme-fix"), links("acme-api"), links("acme-ui", ["acme-api"])],
      archiveAnchors: [],
    });
    expect(
      inventory.worksets.map((entry) => [
        entry.id,
        entry.implicit,
        entry.members.map((m) => m.name),
      ]),
    ).toEqual([
      ["acme-api", true, ["acme-api", "acme-ui"]],
      ["acme-fix", true, ["acme-fix"]],
      ["acme-idea", false, []],
    ]);
    expect(inventory.worksets.every((entry) => entry.actionable)).toBe(true);
  });

  test("a record listing its proposed changes names their group and keeps archived ones", () => {
    const inventory = buildInventory({
      listing: { worksets: [record("acme-login", ["acme-a", "acme-old"])], problems: [] },
      activeChanges: [scope("acme-a")],
      links: [links("acme-a")],
      archiveAnchors: ["2026-10-01-acme-old"],
    });
    const [entry] = inventory.worksets;
    expect(entry?.id).toBe("acme-login");
    expect(entry?.implicit).toBe(false);
    expect(entry?.members).toEqual([
      { name: "acme-a", kind: "active" },
      { name: "acme-old", kind: "archived", anchor: "2026-10-01-acme-old" },
    ]);
  });

  test("two records listing one change make one blocked group, no phantom missing member", () => {
    const inventory = buildInventory({
      listing: {
        worksets: [record("acme-one", ["acme-pay"]), record("acme-two", ["acme-pay"])],
        problems: [],
      },
      activeChanges: [scope("acme-pay")],
      links: [links("acme-pay")],
      archiveAnchors: [],
    });
    expect(inventory.worksets.map((entry) => entry.id)).toEqual(["acme-one"]);
    const [entry] = inventory.worksets;
    expect(entry?.actionable).toBe(false);
    expect(entry?.diagnostics.join(" ")).toContain(
      "listed by several Worksets: acme-one, acme-two",
    );
    expect(entry?.members).toEqual([{ name: "acme-pay", kind: "active" }]);
  });

  test("an idea named like a change collides; unreadable records make grouping uncertain", () => {
    const inventory = buildInventory({
      listing: {
        worksets: [record("acme-login")],
        problems: [{ path: ".mate/scratchpad/acme-x.yaml", reason: "is not a mapping" }],
      },
      activeChanges: [scope("acme-login")],
      links: [links("acme-login")],
      archiveAnchors: [],
    });
    const change = inventory.worksets.find((entry) => entry.implicit)!;
    expect(change.actionable).toBe(false);
    expect(change.diagnostics.join(" ")).toContain("collide");
    expect(change.diagnostics.join(" ")).toContain("uncertain");
    expect(inventory.diagnostics).toEqual([".mate/scratchpad/acme-x.yaml: is not a mapping"]);
  });

  test("unreadable or missing scopes block the change", () => {
    const inventory = buildInventory({
      listing: { worksets: [], problems: [] },
      activeChanges: [
        { name: "acme-a", repositories: null },
        { name: "acme-b", repositories: [] },
      ],
      links: [links("acme-a"), links("acme-b")],
      archiveAnchors: [],
    });
    expect(inventory.worksets.map((entry) => entry.actionable)).toEqual([false, false]);
  });
});
