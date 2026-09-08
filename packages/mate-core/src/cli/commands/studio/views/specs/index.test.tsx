/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioCompanionPayload } from "../../payload";
import { groupSpecsByArea, Specs } from "./index";

function payload(overrides: Partial<StudioCompanionPayload> = {}): StudioCompanionPayload {
  return {
    companionPath: "/home/dev/.mate/companions/acme-companion",
    changes: [],
    specs: [],
    topology: null,
    warnings: [],
    ...overrides,
  };
}

describe("Specs", () => {
  it("presents one card per Area, and none of the Dashboard's changes", () => {
    const markup = String(
      <Specs
        payload={payload({
          changes: [{ name: "add-auth", artifacts: [] }],
          specs: [
            { capability: "acme-login", areas: ["acme"], requirementCount: 3 },
            { capability: "acme-search", areas: ["docs"], valid: false, issueCount: 2 },
          ],
        })}
      />,
    );
    expect(markup).toContain("<h3>Specs by Area</h3>");
    expect(markup).toContain('aria-label="Area acme"');
    expect(markup).toContain('aria-label="Area docs"');
    expect(markup).toContain("3 requirements");
    expect(markup).toContain("2 issues");
    expect(markup).not.toContain("<h3>Changes</h3>");
    expect(markup).not.toContain("add-auth");
  });

  it("says so when the companion holds no spec", () => {
    expect(String(<Specs payload={payload()} />)).toContain("No specs in this companion.");
  });

  it("reports collection warnings", () => {
    const markup = String(<Specs payload={payload({ warnings: ["topology: unreadable"] })} />);
    expect(markup).toContain("topology: unreadable");
  });

  it("renders an Area containing markup characters as text", () => {
    const markup = String(
      <Specs payload={payload({ specs: [{ capability: "c", areas: ["<i>a</i>"] }] })} />,
    );
    expect(markup).not.toContain("<i>a</i>");
    expect(markup).toContain("&lt;i&gt;a&lt;/i&gt;");
  });
});

describe("groupSpecsByArea", () => {
  it("lists a spec under every Area it binds, ordered by Area", () => {
    const groups = groupSpecsByArea([
      { capability: "acme-login", areas: ["packages/core", "apps/web"] },
      { capability: "acme-search", areas: ["apps/web"] },
    ]);
    expect(groups.map(([area]) => area)).toEqual(["apps/web", "packages/core"]);
    expect(groups[0]![1].map((spec) => spec.capability)).toEqual(["acme-login", "acme-search"]);
  });

  it("groups a spec binding no Area as unassigned", () => {
    expect(groupSpecsByArea([{ capability: "acme-login", areas: [] }])[0]![0]).toBe("unassigned");
  });
});
