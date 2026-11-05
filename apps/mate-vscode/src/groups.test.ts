import { describe, expect, test } from "bun:test";

import { deliveryBranchFor, parseDeliveries, type OpenChange } from "./changes";
import { groupSessions, latestSession, sessionLabel, worksetSessions, worksetsOf } from "./groups";
import { repositoryIdOf } from "./repository";
import type { Session } from "./sessions";

const NOW = new Date("2026-03-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    runtime: "claude",
    cwd: "/w/acme",
    startedAt: daysAgo(1),
    lastSeenAt: daysAgo(1),
    state: "parked",
    ...extra,
  };
}

const change = (name: string, deliveryBranch?: string): OpenChange => ({
  name,
  done: 0,
  total: 0,
  ...(deliveryBranch ? { deliveryBranch } : {}),
});

const isRunning = (s: Session) => s.state === "running";

describe("worksets", () => {
  test("changes sharing a Delivery Branch form one Workset; others stand alone", () => {
    const worksets = worksetsOf([
      change("acme-queue", "workset/acme"),
      change("acme-retry", "workset/acme"),
      change("acme-solo"),
    ]);
    expect(worksets.map((w) => [w.label, w.branch, w.changes.map((c) => c.name)])).toEqual([
      ["acme", "workset/acme", ["acme-queue", "acme-retry"]],
      ["acme-solo", undefined, ["acme-solo"]],
    ]);
  });
});

describe("session groups", () => {
  const worksets = worksetsOf([change("acme-queue", "workset/acme")]);

  test("Workset, branch, default branch, then Older; running first inside a group", () => {
    const groups = groupSessions(
      [
        session("main-old", { branch: "main", lastSeenAt: daysAgo(20) }),
        session("main-new", { branch: "main" }),
        session("ws-parked", { branch: "workset/acme", lastSeenAt: daysAgo(0) }),
        session("ws-running", { branch: "workset/acme", lastSeenAt: daysAgo(3), state: "running" }),
        session("ws-old", { branch: "workset/acme", lastSeenAt: daysAgo(40) }),
        session("feature", { branch: "feature/x" }),
        session("old-running", { branch: "main", lastSeenAt: daysAgo(30), state: "running" }),
      ],
      worksets,
      "main",
      isRunning,
      NOW,
    );
    expect(groups.map((g) => [g.kind, g.label, g.sessions.map((s) => s.id)])).toEqual([
      ["workset", "acme", ["ws-running", "ws-parked", "ws-old"]],
      ["branch", "feature/x", ["feature"]],
      ["default", "main", ["old-running", "main-new"]],
      ["older", "Older", ["main-old"]],
    ]);
  });
});

describe("session labels", () => {
  test("change, then the Workset's only change, then the first prompt, then the short id", () => {
    const one = worksetsOf([change("acme-queue", "workset/acme")]);
    const two = worksetsOf([
      change("acme-queue", "workset/acme"),
      change("acme-retry", "workset/acme"),
    ]);
    expect(sessionLabel(session("s", { change: "acme-retry", branch: "workset/acme" }), one)).toBe(
      "acme-retry",
    );
    expect(sessionLabel(session("s", { branch: "workset/acme", label: "x" }), one)).toBe(
      "acme-queue",
    );
    expect(
      sessionLabel(session("s", { branch: "workset/acme", label: "How\n does it work?" }), two),
    ).toBe("How does it work?");
    expect(sessionLabel(session("0b7c0000-1111-2222-3333-acmeacme0001"), [])).toBe("acme0001");
  });

  test("a Workset's latest session", () => {
    const [workset] = worksetsOf([change("acme-queue", "workset/acme")]);
    const sessions = [
      session("a", { branch: "workset/acme", lastSeenAt: daysAgo(2) }),
      session("b", { branch: "workset/acme", lastSeenAt: daysAgo(1) }),
      session("c", { branch: "main", lastSeenAt: daysAgo(0) }),
    ];
    const onBranch = worksetSessions(workset!, sessions);
    expect(onBranch.map((s) => s.id)).toEqual(["a", "b"]);
    expect(latestSession(onBranch)?.id).toBe("b");
  });
});

describe("delivery records", () => {
  const yaml = [
    "version: 1",
    "change: acme-queue",
    "deliveries:",
    "  - repository: acme/web",
    "    branch: workset/acme",
    "    head: 1111",
    "  - repository: acme/api",
    "    branch: workset/acme-api",
    "ticket: ABC-1",
  ].join("\n");

  test("picks this repository's branch, else the only entry", () => {
    const deliveries = parseDeliveries(yaml);
    expect(deliveries).toEqual([
      { repository: "acme/web", branch: "workset/acme" },
      { repository: "acme/api", branch: "workset/acme-api" },
    ]);
    expect(deliveryBranchFor(deliveries, "acme/api")).toBe("workset/acme-api");
    expect(deliveryBranchFor(deliveries, "Acme/API")).toBe("workset/acme-api");
    expect(deliveryBranchFor(deliveries, null)).toBeUndefined();
    expect(deliveryBranchFor([{ repository: "acme/web", branch: "workset/x" }], null)).toBe(
      "workset/x",
    );
    expect(parseDeliveries("version: 1\ndeliveries: []\n")).toEqual([]);
  });

  test("remote URLs map to org/repository", () => {
    expect(repositoryIdOf("git@github.com:acme/web.git\n")).toBe("acme/web");
    expect(repositoryIdOf("https://gitlab.example.com/group/sub/web.git")).toBe("group/sub/web");
    expect(repositoryIdOf("nonsense")).toBeNull();
  });
});
