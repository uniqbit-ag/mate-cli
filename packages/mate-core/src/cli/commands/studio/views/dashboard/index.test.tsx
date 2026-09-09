/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioCompanionPayload } from "../../payload";
import { Dashboard } from "./index";

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
  it("presents the changes, and leaves the specs to their own view", () => {
    const markup = String(
      <Dashboard
        payload={payload({
          changes: [{ name: "add-auth", completedTasks: 2, totalTasks: 5, artifacts: [] }],
          specs: [{ capability: "acme-login", areas: ["acme"], requirementCount: 3 }],
        })}
      />,
    );
    expect(markup).toContain("<h3>Changes</h3>");
    expect(markup).not.toContain("<h3>Specs by Area</h3>");
    expect(markup).not.toContain("acme-login");
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
    expect(markup).toContain('class="change-cell"');
    expect(markup).toContain('class="artifact-list"');
    expect(markup).toContain("2 issues");
  });

  it("gives an empty section an explicit no-data message", () => {
    expect(String(<Dashboard payload={payload()} />)).toContain("No changes in this companion.");
  });

  it("reports collection warnings", () => {
    const markup = String(<Dashboard payload={payload({ warnings: ["topology: unreadable"] })} />);
    expect(markup).toContain("topology: unreadable");
  });
});
