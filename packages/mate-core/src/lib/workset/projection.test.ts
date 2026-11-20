import { describe, expect, test } from "bun:test";

import type { InventoryWorkset } from "./inventory";
import {
  type Claim,
  LOCAL_ONLY,
  type Progress,
  projectWorkCard,
  type SharingFacts,
  startRefusalOf,
  type WorkContext,
  type WorkFacts,
  workActionRefusal,
} from "./projection";
import type { WorksetStageId } from "./stage";

const operator = { id: "dev@acme.test", label: "Acme Developer" };
const context = (extra: Partial<WorkContext> = {}): WorkContext => ({
  writable: true,
  operator,
  gitBacked: true,
  factory: { mode: false, usable: false },
  ...extra,
});
const SHARED: SharingFacts = { ...LOCAL_ONLY, presence: "shared" };

function facts(
  options: {
    members?: string[];
    stage?: WorksetStageId;
    sharing?: SharingFacts;
    claim?: Claim;
    progress?: Progress;
    queuedAt?: string;
    legacy?: boolean;
    run?: WorkFacts["run"];
  } = {},
): WorkFacts {
  const members = options.members ?? ["acme-login"];
  const inventory: InventoryWorkset = {
    id: "acme-login",
    implicit: true,
    record: {
      id: "acme-login",
      title: "acme-login",
      intent: "",
      repositories: ["acme/web"],
      changes: members,
      stage: "ready",
      createdAt: "",
      ...(options.queuedAt ? { queuedAt: options.queuedAt } : {}),
      ...(options.legacy ? { legacy: true } : {}),
      extra: {},
    },
    members: members.map((name) => ({ name, kind: "active" as const })),
    diagnostics: [],
    actionable: true,
  };
  const stage = options.stage ?? "human-review";
  return {
    inventory,
    stage: { stage, label: stage, problems: [] } as unknown as WorkFacts["stage"],
    members: members.map((name) => ({ name, stage, stageLabel: stage, delivered: false })),
    sharing: options.sharing ?? LOCAL_ONLY,
    claim: options.claim ?? { kind: "none" },
    progress: options.progress ?? { kind: "none" },
    ...(options.run ? { run: options.run } : {}),
  };
}

const bucket = (input: WorkFacts) => projectWorkCard(input, context()).bucket;

describe("bucket placement", () => {
  test("an idea is in Scratchpad, an unshared change in Local work", () => {
    expect(bucket(facts({ members: [], stage: "clarify-intent" }))).toBe("scratchpad");
    expect(bucket(facts())).toBe("local");
  });

  test("shared work is Remote unless it is claimed by the operator or built here", () => {
    expect(bucket(facts({ sharing: SHARED }))).toBe("remote");
    expect(bucket(facts({ sharing: SHARED, claim: { kind: "mine", label: "Acme" } }))).toBe(
      "local",
    );
    expect(
      bucket(
        facts({
          sharing: SHARED,
          claim: { kind: "other", label: "Acme Teammate", id: "t@acme.test" },
        }),
      ),
    ).toBe("remote");
    expect(
      bucket(facts({ sharing: SHARED, progress: { kind: "here", branch: "workset/acme-login" } })),
    ).toBe("local");
    expect(
      bucket(
        facts({ sharing: SHARED, progress: { kind: "elsewhere", branch: "workset/acme-login" } }),
      ),
    ).toBe("remote");
  });
});

describe("actions", () => {
  test("Remote work offers Claim on available work only", () => {
    const available = projectWorkCard(facts({ sharing: SHARED }), context());
    expect(available.actions).toEqual({ claim: null });
    const elsewhere = projectWorkCard(
      facts({ sharing: SHARED, progress: { kind: "elsewhere", branch: "workset/acme-login" } }),
      context(),
    );
    expect(elsewhere.actions.claim).toBe("in progress on workset/acme-login");
  });

  test("Local work offers Share and a manual start; own claims offer Release", () => {
    expect(projectWorkCard(facts(), context()).actions).toEqual({
      share: null,
      "start-manual": null,
    });
    const mine = projectWorkCard(
      facts({ sharing: SHARED, claim: { kind: "mine", label: "Acme" } }),
      context(),
    );
    expect(mine.actions).toEqual({
      share: "already shared with no local changes",
      "start-manual": null,
      release: null,
    });
  });

  test("submitted work is neither shared, claimed nor started", () => {
    const local = facts({ stage: "merge-wait" });
    expect(workActionRefusal("share", local, context())).toContain("submitted for publication");
    expect(workActionRefusal("start-manual", local, context())).toContain(
      "submitted for publication",
    );
    const remote = facts({ stage: "publish", sharing: SHARED });
    expect(workActionRefusal("claim", remote, context())).toContain("submitted for publication");
  });

  test("starting another's or unclaimed shared work is refused on the server too", () => {
    const other = facts({
      sharing: SHARED,
      claim: { kind: "other", label: "Acme Teammate", id: "t@acme.test" },
    });
    expect(workActionRefusal("start-manual", other, context())).toBe("claimed by Acme Teammate");
    expect(workActionRefusal("start-manual", facts({ sharing: SHARED }), context())).toBe(
      "claim it first",
    );
  });

  test("a teammate's claim wins over a local branch of the same name", () => {
    const branched = facts({
      sharing: { ...SHARED, sync: "ahead" },
      claim: { kind: "other", label: "Acme Teammate", id: "t@acme.test" },
      progress: { kind: "here", branch: "workset/acme-login" },
    });
    const usable = context({ factory: { mode: true, usable: true } });
    for (const action of ["share", "start-manual", "dispatch"] as const) {
      expect(workActionRefusal(action, branched, usable)).toBe("claimed by Acme Teammate");
    }
    expect(startRefusalOf(branched)).toBe("claimed by Acme Teammate");
  });

  test("behind or diverged work is synced before Share or a start", () => {
    const behind = facts({
      sharing: { ...SHARED, sync: "behind" },
      claim: { kind: "mine", label: "Acme" },
    });
    expect(workActionRefusal("share", behind, context())).toContain("mate artifact take");
    expect(workActionRefusal("start-manual", behind, context())).toContain("mate artifact take");
  });

  test("Release waits for a local run; a conflicting claim blocks everything", () => {
    const running = facts({
      sharing: SHARED,
      claim: { kind: "mine", label: "Acme" },
      run: "running",
    });
    expect(workActionRefusal("release", running, context())).toBe(
      "it runs here; stop the run first",
    );
    const conflict = facts({
      sharing: SHARED,
      claim: { kind: "conflict", diagnostic: "only some of its changes are claimed" },
    });
    expect(workActionRefusal("claim", conflict, context())).toBe(
      "only some of its changes are claimed",
    );
  });

  test("read-only Studio refuses every mutation; claims need a Git identity", () => {
    expect(workActionRefusal("share", facts(), context({ writable: false }))).toContain(
      "read-only",
    );
    expect(
      workActionRefusal("claim", facts({ sharing: SHARED }), context({ operator: undefined })),
    ).toContain("user.name");
  });

  test("factory actions exist only in factory mode and only for own work", () => {
    expect(projectWorkCard(facts(), context()).actions.dispatch).toBeUndefined();
    const factory = context({ factory: { mode: true, usable: true } });
    expect(projectWorkCard(facts(), factory).actions.dispatch).toBeNull();
    expect(projectWorkCard(facts({ sharing: SHARED }), factory).actions.dispatch).toBeUndefined();
    expect(workActionRefusal("dispatch", facts({ sharing: SHARED }), factory)).toBe(
      "claim it first",
    );
  });

  test("a queued plan parks; a legacy shared start is never this installation's", () => {
    const factory = context({ factory: { mode: true, usable: true } });
    const queued = facts({ queuedAt: "2026-11-01T00:00:00.000Z", run: "idle" });
    expect(projectWorkCard(queued, factory).actions.park).toBeNull();
    expect(projectWorkCard(queued, factory).actions.dispatch).toBe(
      "already started in the factory",
    );
    const legacy = facts({ queuedAt: "2026-11-01T00:00:00.000Z", legacy: true });
    expect(projectWorkCard(legacy, factory).actions.park).toBeUndefined();
    expect(projectWorkCard(legacy, factory).actions.dispatch).toBeNull();
  });
});
