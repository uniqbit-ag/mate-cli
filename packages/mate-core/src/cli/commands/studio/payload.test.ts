import { describe, expect, test } from "bun:test";

import { assembleCompanionPayload, type CompanionPayloadDeps } from "./payload";

function deps(overrides: Partial<CompanionPayloadDeps> = {}): CompanionPayloadDeps {
  return {
    listChanges: async () => ({
      ok: true,
      value: {
        changes: [
          {
            name: "add-checkout",
            completedTasks: 3,
            totalTasks: 7,
            status: "in-progress",
            lastModified: "2026-01-02T00:00:00Z",
          },
          { name: "add-docs", completedTasks: 0, totalTasks: 0, status: "no-tasks" },
        ],
      },
    }),
    listSpecs: async () => ({
      ok: true,
      value: { specs: [{ id: "acme-checkout", requirementCount: 4 }] },
    }),
    readAllChangeStatus: async () => ({
      ok: true,
      value: {
        changes: [
          {
            changeName: "add-checkout",
            schemaName: "acme-v1",
            planningHome: { root: "/companions/acme" },
            artifacts: [
              { id: "brief", status: "done" },
              { id: "tasks", status: "pending" },
            ],
          },
        ],
      },
    }),
    validateAll: async () => ({
      ok: true,
      value: {
        items: [
          { id: "add-checkout", type: "change", valid: false, issues: [{ level: "ERROR" }] },
          { id: "acme-checkout", type: "spec", valid: true, issues: [] },
        ],
      },
    }),
    readWorkflowTopology: async () => ({
      ok: true,
      value: {
        schemaName: "acme-v1",
        workflowCapabilityId: "openspec",
        source: "project",
        artifacts: [
          { id: "brief", requires: [] },
          { id: "tasks", requires: ["brief"] },
        ],
        edges: [{ from: "brief", to: "tasks" }],
        apply: { requires: ["tasks"], tracks: "tasks.md" },
      },
    }),
    readSpecAreas: async () => ["acme"],
    ...overrides,
  };
}

describe("assembleCompanionPayload", () => {
  test("composes changes, specs, and topology into one response", async () => {
    const payload = await assembleCompanionPayload("/companions/acme", deps());

    if ("error" in payload) throw new Error(`unexpected error payload: ${payload.error.reason}`);
    expect(payload.companionPath).toBe("/companions/acme");
    expect(payload.changes).toEqual([
      {
        name: "add-checkout",
        completedTasks: 3,
        totalTasks: 7,
        status: "in-progress",
        lastModified: "2026-01-02T00:00:00Z",
        schemaName: "acme-v1",
        artifacts: [
          { id: "brief", status: "done" },
          { id: "tasks", status: "pending" },
        ],
        valid: false,
        issueCount: 1,
      },
      {
        name: "add-docs",
        completedTasks: 0,
        totalTasks: 0,
        status: "no-tasks",
        artifacts: [],
      },
    ]);
    expect(payload.specs).toEqual([
      {
        capability: "acme-checkout",
        requirementCount: 4,
        areas: ["acme"],
        valid: true,
        issueCount: 0,
      },
    ]);
    expect(payload.topology?.schemaName).toBe("acme-v1");
    expect(payload.warnings).toEqual([]);
  });

  test("resolves spec Areas under the planning home the status reports", async () => {
    const roots: string[] = [];
    await assembleCompanionPayload(
      "/companions/acme",
      deps({
        readSpecAreas: async (specsRoot) => {
          roots.push(specsRoot);
          return [];
        },
      }),
    );

    expect(roots).toEqual(["/companions/acme/openspec/specs"]);
  });

  test("returns an error payload naming the companion when changes cannot be collected", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        listChanges: async () => ({
          ok: false,
          failure: { command: "openspec list --json", reason: "exit code 1: no mate context" },
        }),
      }),
    );

    expect(payload).toEqual({
      error: {
        companionPath: "/companions/acme",
        reason: "openspec list --json: exit code 1: no mate context",
      },
    });
  });

  test("returns an error payload when the artifact status cannot be collected", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        readAllChangeStatus: async () => ({
          ok: false,
          failure: { command: "openspec status --all --json", reason: "exit code 2" },
        }),
      }),
    );

    expect("error" in payload).toBe(true);
    if (!("error" in payload)) throw new Error("expected an error payload");
    expect(payload.error.companionPath).toBe("/companions/acme");
    expect(payload.error.reason).toContain("openspec status --all --json");
  });

  test("degrades to a warning when the topology cannot be read", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        readWorkflowTopology: async () => ({
          ok: false,
          failure: { command: "workflow topology for acme-v1", reason: "schema absent" },
        }),
      }),
    );

    if ("error" in payload) throw new Error("expected a payload");
    expect(payload.topology).toBeNull();
    expect(payload.warnings).toEqual(["workflow topology for acme-v1: schema absent"]);
    expect(payload.changes).toHaveLength(2);
  });

  test("degrades to a warning when validation cannot be collected", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        validateAll: async () => ({
          ok: false,
          failure: { command: "openspec validate --all --json", reason: "exit code 2" },
        }),
      }),
    );

    if ("error" in payload) throw new Error("expected a payload");
    expect(payload.warnings).toEqual(["openspec validate --all --json: exit code 2"]);
    expect(payload.changes[0]).not.toHaveProperty("valid");
  });

  test("returns empty collections for a companion with no OpenSpec content", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        listChanges: async () => ({ ok: true, value: {} }),
        listSpecs: async () => ({ ok: true, value: {} }),
        readAllChangeStatus: async () => ({ ok: true, value: {} }),
      }),
    );

    if ("error" in payload) throw new Error("expected a payload");
    expect(payload.changes).toEqual([]);
    expect(payload.specs).toEqual([]);
  });
});
