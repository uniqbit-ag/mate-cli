import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ArchiveEntry } from "../artifact/pending/discovery";
import { assembleCompanionPayload, type CompanionPayloadDeps } from "./payload";

function archive(anchor: string, state: ArchiveEntry["state"] = "committed"): ArchiveEntry {
  return {
    name: anchor.slice(11),
    anchor,
    path: `openspec/changes/archive/${anchor}`,
    tag: `openspec/${anchor}`,
    uncommittedPaths: [],
    uncommittedSpecs: [],
    uncommittedSpecChanges: [],
    state,
  };
}

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
    readUncommittedPaths: async () => [],
    discoverArchives: async () => [],
    canonicalSpecsFor: async () => [],
    hasArchivedProposal: async () => true,
    readWorksets: async () => ({ worksets: [], problems: [] }),
    linkedRepositoryIdentities: async () => [],
    ...overrides,
  };
}

function workset(
  id: string,
  changes: string[],
  stage: "clarify-intent" | "explore" | "ready" = "clarify-intent",
) {
  return {
    id,
    title: id,
    intent: "",
    repositories: ["acme/web"],
    changes,
    stage,
    createdAt: "2026-10-29T10:00:00Z",
    extra: {},
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
    expect(payload.skills).toEqual([]);
    expect(payload.skillInventory).toEqual({ claude: [], opencode: [], agents: [] });
    expect(payload.warnings).toEqual([]);
  });

  test("includes Mate-owned runtime skill names without collecting hand-authored trees", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        collectSkillInventory: async () => ({
          claude: ["mate-grill-me"],
          opencode: ["mate-interview-me"],
          agents: ["mate-domain-modeling"],
        }),
      }),
    );

    if ("error" in payload) throw new Error(`unexpected error payload: ${payload.error.reason}`);
    expect(payload.skills).toEqual(["mate-domain-modeling", "mate-grill-me", "mate-interview-me"]);
    expect(payload.skillInventory).toEqual({
      claude: ["mate-grill-me"],
      opencode: ["mate-interview-me"],
      agents: ["mate-domain-modeling"],
    });
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
    expect(payload.shipped).toEqual([]);
  });

  describe("shipped changes", () => {
    test("carries committed archives newest first with their capabilities", async () => {
      const seen: string[][] = [];
      const payload = await assembleCompanionPayload(
        "/companions/acme",
        deps({
          readUncommittedPaths: async () => ["openspec/changes/archive/2026-03-01-acme-pending/"],
          discoverArchives: async (_companion, uncommitted) => {
            seen.push(uncommitted);
            return [
              archive("2026-01-05-acme-login"),
              archive("2026-02-10-acme-checkout"),
              archive("2026-03-01-acme-pending", "uncommitted"),
            ];
          },
          canonicalSpecsFor: async (_companion, anchor) =>
            anchor === "2026-02-10-acme-checkout"
              ? ["openspec/specs/acme-checkout/spec.md", "openspec/specs/acme/billing/spec.md"]
              : ["openspec/specs/acme-login/spec.md"],
          hasArchivedProposal: async (_companion, anchor) => anchor !== "2026-01-05-acme-login",
        }),
      );

      if ("error" in payload) throw new Error("expected a payload");
      expect(seen).toEqual([["openspec/changes/archive/2026-03-01-acme-pending/"]]);
      expect(payload.shipped).toEqual([
        {
          name: "acme-checkout",
          anchor: "2026-02-10-acme-checkout",
          archivedOn: "2026-02-10",
          specs: ["acme-checkout", "acme/billing"],
          hasProposal: true,
        },
        {
          name: "acme-login",
          anchor: "2026-01-05-acme-login",
          archivedOn: "2026-01-05",
          specs: ["acme-login"],
          hasProposal: false,
        },
      ]);
      expect(payload.warnings).toEqual([]);
    });

    test("ignores undated archive directories", async () => {
      const payload = await assembleCompanionPayload(
        "/companions/acme",
        deps({
          discoverArchives: async () => [archive("acme-undated"), archive("2026-01-05-acme")],
        }),
      );

      if ("error" in payload) throw new Error("expected a payload");
      expect(payload.shipped.map((change) => change.anchor)).toEqual(["2026-01-05-acme"]);
    });

    test("carries an archive without delta specs naming no capabilities", async () => {
      const payload = await assembleCompanionPayload(
        "/companions/acme",
        deps({ discoverArchives: async () => [archive("2026-01-05-acme")] }),
      );

      if ("error" in payload) throw new Error("expected a payload");
      expect(payload.shipped[0]?.specs).toEqual([]);
    });

    test("degrades to a warning when working-tree status cannot be read", async () => {
      const payload = await assembleCompanionPayload(
        "/companions/acme",
        deps({
          readUncommittedPaths: async () => {
            throw new Error("companion is not a Git root");
          },
          discoverArchives: async () => [archive("2026-01-05-acme")],
        }),
      );

      if ("error" in payload) throw new Error("expected a payload");
      expect(payload.shipped).toEqual([]);
      expect(payload.warnings).toEqual(["shipped changes: companion is not a Git root"]);
      expect(payload.changes).toHaveLength(2);
      expect(payload.specs).toHaveLength(1);
    });

    test("reads real archive directories by name only", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-shipped-"));
      try {
        const archiveDir = path.join(root, "openspec/changes/archive");
        await fs.mkdir(path.join(archiveDir, "2026-01-05-acme/specs/acme"), { recursive: true });
        await fs.writeFile(path.join(archiveDir, "2026-01-05-acme/proposal.md"), "x");
        await fs.writeFile(path.join(archiveDir, "2026-01-05-acme/specs/acme/spec.md"), "x");
        await fs.mkdir(path.join(archiveDir, "2026-02-01-acme-minimal"), { recursive: true });
        await fs.mkdir(path.join(archiveDir, "notes"), { recursive: true });

        const {
          discoverArchives: _discover,
          canonicalSpecsFor: _specs,
          hasArchivedProposal: _proposal,
          ...rest
        } = deps();
        const payload = await assembleCompanionPayload(root, rest);

        if ("error" in payload) throw new Error("expected a payload");
        expect(payload.shipped).toEqual([
          {
            name: "acme-minimal",
            anchor: "2026-02-01-acme-minimal",
            archivedOn: "2026-02-01",
            specs: [],
            hasProposal: false,
          },
          {
            name: "acme",
            anchor: "2026-01-05-acme",
            archivedOn: "2026-01-05",
            specs: ["acme"],
            hasProposal: true,
          },
        ]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("Worksets in the payload", () => {
  test("derive each Workset's stage from its linked changes", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        readWorksets: async () => ({
          worksets: [
            workset("acme-explore", [], "explore"),
            workset("acme-review", ["add-docs"]),
            workset("acme-ship", ["acme-shipped"]),
            workset("acme-merge", ["acme-unmerged"]),
          ],
          problems: [{ path: "worksets/acme-bad.yaml", reason: "is not a mapping" }],
        }),
        readAllChangeStatus: async () => ({
          ok: true,
          value: {
            changes: [
              {
                changeName: "add-docs",
                schemaName: "mate-minimal",
                artifacts: [
                  { id: "specs", status: "done" },
                  { id: "tasks", status: "done" },
                ],
              },
            ],
          },
        }),
        archiveAnchors: async () => ["2026-10-01-acme-shipped", "2026-10-02-acme-unmerged"],
        discoverArchives: async () => [archive("2026-10-01-acme-shipped")],
        archiveMergeSettled: async (_companion, anchor) => anchor === "2026-10-01-acme-shipped",
        linkedRepositoryIdentities: async () => ["acme/web"],
      }),
    );
    if ("error" in payload) throw new Error(payload.error.reason);
    expect(
      payload.worksets.map(({ id, stage, stageLabel, turn }) => [id, stage, stageLabel, turn]),
    ).toEqual([
      ["acme-explore", "explore", "Explore change", "human"],
      ["acme-review", "human-review", "Review specs, tasks", "human"],
      ["acme-ship", "done", "Done", "none"],
      ["acme-merge", "merge-wait", "Waiting for merge", "human"],
    ]);
    expect(payload.worksetProblems).toEqual([
      { path: "worksets/acme-bad.yaml", reason: "is not a mapping" },
    ]);
    expect(payload.linkedRepositories).toEqual(["acme/web"]);
  });

  test("a companion without Worksets reads no Delivery Record", async () => {
    let reads = 0;
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        archiveMergeSettled: async () => {
          reads++;
          return true;
        },
      }),
    );
    if ("error" in payload) throw new Error(payload.error.reason);
    expect(payload.worksets).toEqual([]);
    expect(reads).toBe(0);
  });

  test("an unreadable worksets directory degrades to a warning", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        readWorksets: async () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    );
    if ("error" in payload) throw new Error(payload.error.reason);
    expect(payload.worksets).toEqual([]);
    expect(payload.warnings).toContain("worksets: EACCES: permission denied");
  });
});
