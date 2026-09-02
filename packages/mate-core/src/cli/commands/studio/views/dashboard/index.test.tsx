/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioCompanionPayload } from "../../payload";
import { Dashboard } from "./index";
import { groupSpecsByArea } from "./specs";

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

describe("Dashboard", () => {
  it("presents distinct sections for changes and for specs by Area", () => {
    const markup = String(
      <Dashboard
        payload={payload({
          changes: [{ name: "add-auth", completedTasks: 2, totalTasks: 5, artifacts: [] }],
          specs: [{ capability: "acme-login", areas: ["acme"], requirementCount: 3 }],
        })}
      />,
    );
    expect(markup).toContain("<h3>Changes</h3>");
    expect(markup).toContain("<h3>Specs by Area</h3>");
    expect(markup).toContain('aria-label="Area acme"');
  });

  it("shows a change's completed and total task counts", () => {
    const markup = String(
      <Dashboard
        payload={payload({
          changes: [
            { name: "add-auth", completedTasks: 2, totalTasks: 5, status: "active", artifacts: [] },
          ],
        })}
      />,
    );
    expect(markup).toContain("2 / 5");
    expect(markup).toContain('style="width:40%"');
  });

  it("says so when a change tracks no tasks", () => {
    const markup = String(
      <Dashboard payload={payload({ changes: [{ name: "add-auth", artifacts: [] }] })} />,
    );
    expect(markup).toContain("no tasks");
    expect(markup).not.toContain("bar-fill");
  });

  it("reports each change's artifacts and its validation", () => {
    const markup = String(
      <Dashboard
        payload={payload({
          changes: [
            {
              name: "add-auth",
              artifacts: [{ id: "proposal", status: "done" }, { id: "tasks" }],
              valid: false,
              issueCount: 2,
            },
          ],
        })}
      />,
    );
    expect(markup).toContain('class="chip chip-done">proposal<');
    expect(markup).toContain('class="chip chip-pending">tasks<');
    expect(markup).toContain("2 issues");
  });

  it("gives each empty section an explicit no-data message", () => {
    const markup = String(<Dashboard payload={payload()} />);
    expect(markup).toContain("No changes in this companion.");
    expect(markup).toContain("No specs in this companion.");
  });

  it("reports collection warnings", () => {
    const markup = String(<Dashboard payload={payload({ warnings: ["topology: unreadable"] })} />);
    expect(markup).toContain("topology: unreadable");
  });

  it("renders an Area containing markup characters as text", () => {
    const markup = String(
      <Dashboard payload={payload({ specs: [{ capability: "c", areas: ["<i>a</i>"] }] })} />,
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
