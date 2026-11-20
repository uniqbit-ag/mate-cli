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
    readSpecScopes: async () => [{ repository: "acme/shop", area: "acme" }],
    readUncommittedPaths: async () => [],
    discoverArchives: async () => [],
    canonicalSpecsFor: async () => [],
    hasArchivedProposal: async () => true,
    readWorksets: async () => ({ worksets: [], problems: [] }),
    linkedRepositoryCatalog: async () => ({
      identities: [],
      aliases: new Map(),
      kinds: new Map(),
      keys: new Map(),
      problem: null,
    }),
    ticketFormat: async () => "none",
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
  test("an unreadable ticket setting hides tickets and says why", async () => {
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        ticketFormat: async () => {
          throw new Error("framework.yaml is not valid YAML");
        },
      }),
    );
    if ("error" in payload) throw new Error(payload.error.reason);
    expect(payload.ticketFormat).toBe("none");
    expect(payload.warnings).toContain("ticket setting: framework.yaml is not valid YAML");
  });

  test("composes changes, specs, and topology into one response", async () => {
    const payload = await assembleCompanionPayload("/companions/acme", deps());

    if ("error" in payload) throw new Error(`unexpected error payload: ${payload.error.reason}`);
    expect(payload.companionPath).toBe("/companions/acme");
    expect(payload.changes.map(({ position: _position, ...change }) => change)).toEqual([
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
        scopes: [{ repository: "acme/shop", area: "acme" }],
        valid: true,
        issueCount: 0,
      },
    ]);
    expect(payload.topology?.schemaName).toBe("acme-v1");
    expect(payload.skills).toEqual([]);
    expect(payload.skillInventory).toEqual({ claude: [], opencode: [], agents: [] });
    expect(payload.warnings).toEqual([]);
  });

  test("places each change as `mate workflow next` does, its validation deciding the plan", async () => {
    const companion = await fs.mkdtemp(path.join(os.tmpdir(), "acme-payload-"));
    try {
      const changes = path.join(companion, "openspec", "changes");
      await fs.mkdir(path.join(changes, "add-checkout"), { recursive: true });
      await fs.writeFile(
        path.join(changes, "add-checkout", "tasks.md"),
        "- [x] 1.1 Acme\n- [x] 1.2 Acme\n",
      );
      await fs.mkdir(path.join(changes, "add-docs"), { recursive: true });
      await fs.writeFile(
        path.join(changes, "add-docs", "tasks.md"),
        "- [x] 1.1 Acme\n- [ ] 1.2 Acme\n- [ ] 1.3 Acme\n",
      );
      await fs.writeFile(path.join(changes, "add-docs", "proposal.md"), "# Acme\n");
      const payload = await assembleCompanionPayload(
        companion,
        deps({ readAllChangeStatus: async () => ({ ok: true, value: { changes: [] } }) }),
      );
      if ("error" in payload) throw new Error(payload.error.reason);
      const placed = payload.changes.map((change) => ({
        stage: change.position?.stage?.id,
        open: change.position?.open,
        actions: change.position?.handoff.actions,
      }));
      expect(placed).toEqual([
        {
          stage: "propose",
          open: "the change does not validate",
          actions: [
            {
              kind: "skill",
              skill: "mate-propose-change",
              change: "add-checkout",
              note: "the change does not validate",
            },
          ],
        },
        {
          stage: "apply",
          open: "2 tasks open",
          actions: [
            { kind: "skill", skill: "mate-apply-change", change: "add-docs", note: "2 tasks open" },
          ],
        },
      ]);
    } finally {
      await fs.rm(companion, { recursive: true, force: true });
    }
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
        readSpecScopes: async (specsRoot) => {
          roots.push(specsRoot);
          return [];
        },
      }),
    );

    expect(roots).toEqual(["/companions/acme/openspec/specs"]);
  });

  test("reads spec scopes with the linked registry IDs", async () => {
    const seen: ReadonlyMap<string, string>[] = [];
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        readSpecScopes: async (_root, _spec, _read, aliases = new Map()) => {
          seen.push(aliases);
          return [{ repository: "acme-org/acme", area: "docs" }];
        },
        linkedRepositoryCatalog: async () => ({
          identities: ["acme-org/acme"],
          aliases: new Map([["acme", "acme-org/acme"]]),
          kinds: new Map(),
          keys: new Map(),
          problem: null,
        }),
      }),
    );

    if ("error" in payload) throw new Error(payload.error.reason);
    expect(seen.map((aliases) => [...aliases])).toEqual([[["acme", "acme-org/acme"]]]);
    expect(payload.linkedRepositories).toEqual(["acme-org/acme"]);
  });

  test("reads spec scopes without registry IDs when linked repositories cannot be read", async () => {
    const seen: ReadonlyMap<string, string>[] = [];
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        readSpecScopes: async (_root, _spec, _read, aliases = new Map()) => {
          seen.push(aliases);
          return [{ repository: "acme", area: "docs" }];
        },
        linkedRepositoryCatalog: async () => {
          throw new Error("registry unreadable");
        },
      }),
    );

    if ("error" in payload) throw new Error(payload.error.reason);
    expect(seen.map((aliases) => aliases.size)).toEqual([0]);
    expect(payload.specs[0]?.scopes).toEqual([{ repository: "acme", area: "docs" }]);
    expect(payload.warnings).toEqual(["linked repositories: registry unreadable"]);
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

describe("the Delivery Path in the payload", () => {
  async function companion(declaration?: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-payload-workflow-"));
    if (declaration !== undefined) {
      await fs.mkdir(path.join(root, ".mate", "config"), { recursive: true });
      await fs.writeFile(path.join(root, ".mate", "config", "workflow.yaml"), declaration);
    }
    return root;
  }

  /** The payload of `root`, whose planning home is the companion itself. */
  async function payloadOf(root: string) {
    const payload = await assembleCompanionPayload(
      root,
      deps({ readAllChangeStatus: async () => ({ ok: true, value: { changes: [] } }) }),
    );
    if ("error" in payload) throw new Error(payload.error.reason);
    return payload;
  }

  test("without a declaration it is the built-in default", async () => {
    const root = await companion();
    try {
      const payload = await payloadOf(root);

      expect(payload.workflow?.file).toBeNull();
      expect(payload.workflow?.stages.map((stage) => stage.id)).toEqual([
        "clarify-intent",
        "explore",
        "propose",
        "review",
        "apply",
        "inspect-outcome",
        "refine-code",
        "submit",
        "publish",
      ]);
      expect(payload.workflowProblems).toBeUndefined();
      expect(payload.warnings).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a declared path carries each stage's steps and source", async () => {
    const root = await companion(`version: 1
stages:
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]
  - id: security-review
    label: Security review
    steps: [{ skill: acme-security-review }]
  - id: submit
    artifact: openspec
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
    try {
      const payload = await payloadOf(root);

      expect(payload.workflow?.stages[1]).toEqual({
        id: "security-review",
        label: "Security review",
        kind: "skill",
        optional: false,
        source: "declared",
        steps: [{ skill: "acme-security-review" }],
        entry: "acme-security-review",
      });
      // A declared skill the companion does not hold is a warning, not a problem.
      expect(payload.warnings.join("\n")).toContain("acme-security-review is not in");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("an invalid declaration yields its problems, a warning and no path", async () => {
    const root = await companion("version: 1\npublishing: { mode: single }\n");
    try {
      const payload = await payloadOf(root);

      expect(payload.workflow).toBeNull();
      expect(payload.workflowProblems).toEqual([
        { path: "publishing", message: "unknown key `publishing`" },
        { path: "stages", message: "a custom workflow declares its `stages`" },
      ]);
      expect(payload.warnings).toEqual([
        ".mate/config/workflow.yaml is invalid, so the built-in Delivery Path is shown and no stage runs: publishing: unknown key `publishing`; stages: a custom workflow declares its `stages`",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a change carries its recorded steps by stage", async () => {
    const root = await companion(`version: 1
stages:
  - id: security-review
    steps: [{ skill: acme-security-review }]
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]
  - id: submit
    artifact: openspec
    steps: [{ skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`);
    try {
      const dir = path.join(root, "openspec", "changes", "add-checkout");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "delivery.yaml"),
        "version: 1\nchange: add-checkout\nstages:\n  security-review: [acme-security-review]\n  apply: [mate-apply-change]\ndeliveries: []\n",
      );
      const dropped = path.join(root, "openspec", "changes", "add-docs");
      await fs.mkdir(dropped, { recursive: true });
      await fs.writeFile(
        path.join(dropped, "delivery.yaml"),
        "version: 1\nchange: add-docs\nstate: dropped\ndeliveries: []\n",
      );

      const { changes } = await payloadOf(root);

      expect(changes[0]).toMatchObject({
        name: "add-checkout",
        steps: { "security-review": ["acme-security-review"], apply: ["mate-apply-change"] },
      });
      expect(changes[1]).toMatchObject({ name: "add-docs", dropped: true });
      expect(changes[1]).not.toHaveProperty("steps");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
        linkedRepositoryCatalog: async () => ({
          identities: ["acme/web"],
          aliases: new Map(),
          kinds: new Map([["acme/web", "linked" as const]]),
          keys: new Map([["acme/web", "git.acme.test/acme"]]),
          problem: null,
        }),
        ticketFormat: async () => "jira",
      }),
    );
    if ("error" in payload) throw new Error(payload.error.reason);
    expect(payload.ticketFormat).toBe("jira");
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
    expect(payload.repositoryKeys).toEqual({ "acme/web": "git.acme.test/acme" });
  });

  test("Worksets reuse the change list and archives the payload collected", async () => {
    const calls = { list: 0, status: 0, archives: 0 };
    const base = deps();
    const payload = await assembleCompanionPayload(
      "/companions/acme",
      deps({
        readWorksets: async () => ({
          worksets: [workset("acme-review", ["add-docs"])],
          problems: [],
        }),
        listChanges: async (companion) => {
          calls.list++;
          return base.listChanges!(companion);
        },
        readAllChangeStatus: async (companion) => {
          calls.status++;
          return base.readAllChangeStatus!(companion);
        },
        discoverArchives: async () => {
          calls.archives++;
          return [];
        },
      }),
    );
    if ("error" in payload) throw new Error(payload.error.reason);
    expect(calls).toEqual({ list: 1, status: 1, archives: 1 });
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
