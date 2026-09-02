import { describe, expect, test } from "bun:test";

import { readWorkflowTopology, type WorkflowTopologyDeps } from "./topology";

const ACME_SCHEMA = `
name: acme-v1
version: 3
description: Acme workflow
artifacts:
  - id: brief
    generates: brief.md
    description: Opening brief
    requires: []
  - id: plan
    generates: plan.md
    requires:
      - brief
  - id: checks
    generates: checks.md
    requires:
      - brief
  - id: tasks
    generates: tasks.md
    requires:
      - plan
      - checks
apply:
  requires:
    - tasks
  tracks: tasks.md
`;

function deps(overrides: Partial<WorkflowTopologyDeps> = {}): WorkflowTopologyDeps {
  return {
    readProjectSchemaName: () => "acme-v1",
    readFile: async (filePath) => {
      if (filePath === "/companions/acme/openspec/schemas/acme-v1/schema.yaml") return ACME_SCHEMA;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    locateSchema: async () => ({
      ok: false,
      failure: { command: "openspec schema which", reason: "not called" },
    }),
    ...overrides,
  };
}

describe("readWorkflowTopology", () => {
  test("returns the resolved schema's artifacts, edges, and apply step", async () => {
    const result = await readWorkflowTopology("/companions/acme", deps());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a topology");
    expect(result.value.schemaName).toBe("acme-v1");
    expect(result.value.schemaVersion).toBe(3);
    expect(result.value.workflowCapabilityId).toBe("openspec");
    expect(result.value.artifacts.map((artifact) => artifact.id)).toEqual([
      "brief",
      "plan",
      "checks",
      "tasks",
    ]);
    expect(result.value.artifacts[0]).toEqual({
      id: "brief",
      description: "Opening brief",
      generates: "brief.md",
      requires: [],
    });
    expect(result.value.edges).toEqual([
      { from: "brief", to: "plan" },
      { from: "brief", to: "checks" },
      { from: "plan", to: "tasks" },
      { from: "checks", to: "tasks" },
    ]);
    expect(result.value.apply).toEqual({ requires: ["tasks"], tracks: "tasks.md" });
  });

  test("hard-codes no artifact name: an added artifact appears without a code change", async () => {
    const extended = ACME_SCHEMA.replace(
      "apply:",
      "  - id: rollout\n    generates: rollout.md\n    requires:\n      - tasks\napply:",
    );
    const result = await readWorkflowTopology(
      "/companions/acme",
      deps({ readFile: async () => extended }),
    );

    if (!result.ok) throw new Error("expected a topology");
    expect(result.value.artifacts.map((artifact) => artifact.id)).toContain("rollout");
    expect(result.value.edges).toContainEqual({ from: "tasks", to: "rollout" });
  });

  test("reads the schema of whichever schema the companion resolves", async () => {
    const otherSchema = "name: beta-v2\nartifacts:\n  - id: only\n    requires: []\n";
    const paths: string[] = [];
    const result = await readWorkflowTopology(
      "/companions/beta",
      deps({
        readProjectSchemaName: () => "beta-v2",
        readFile: async (filePath) => {
          paths.push(filePath);
          return otherSchema;
        },
      }),
    );

    if (!result.ok) throw new Error("expected a topology");
    expect(paths).toEqual(["/companions/beta/openspec/schemas/beta-v2/schema.yaml"]);
    expect(result.value.schemaName).toBe("beta-v2");
    expect(result.value.artifacts.map((artifact) => artifact.id)).toEqual(["only"]);
  });

  test("falls back to the CLI-resolved schema directory when the companion holds none", async () => {
    const result = await readWorkflowTopology(
      "/companions/acme",
      deps({
        readProjectSchemaName: () => undefined,
        defaultSchemaName: async () => "spec-driven",
        locateSchema: async (companionPath, schemaName) => {
          expect(companionPath).toBe("/companions/acme");
          expect(schemaName).toBe("spec-driven");
          return { ok: true, value: { path: "/packages/openspec/schemas/spec-driven" } };
        },
        readFile: async (filePath) => {
          if (filePath === "/packages/openspec/schemas/spec-driven/schema.yaml") return ACME_SCHEMA;
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    );

    if (!result.ok) throw new Error("expected a topology");
    expect(result.value.source).toBe("package");
    expect(result.value.artifacts).toHaveLength(4);
  });

  test("returns a typed failure when no schema can be read", async () => {
    const result = await readWorkflowTopology(
      "/companions/acme",
      deps({
        readFile: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        locateSchema: async () => ({
          ok: false,
          failure: { command: "openspec schema which acme-v1 --json", reason: "exit code 1" },
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure.reason).toContain("acme-v1");
  });

  test("returns a typed failure when the schema is malformed", async () => {
    const result = await readWorkflowTopology(
      "/companions/acme",
      deps({ readFile: async () => "artifacts: not-a-list\n" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure.reason).toContain("artifacts");
  });

  test("ignores a dependency on an artifact the schema does not declare", async () => {
    const result = await readWorkflowTopology(
      "/companions/acme",
      deps({
        readFile: async () =>
          "name: acme-v1\nartifacts:\n  - id: plan\n    requires:\n      - ghost\n",
      }),
    );

    if (!result.ok) throw new Error("expected a topology");
    expect(result.value.edges).toEqual([]);
    expect(result.value.artifacts[0]?.requires).toEqual(["ghost"]);
  });
});
