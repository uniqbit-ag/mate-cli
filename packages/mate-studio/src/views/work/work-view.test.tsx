import { describe, expect, it } from "bun:test";

import type { StudioWorkCard, StudioWorkPayload } from "@uniqbit/mate-core/studio";

import { staticMarkup } from "../../../test/render";
import { acceptedActions, dropTargetsOf } from "./work-card-model";
import { validateWorkSearch } from "./work-search";
import { Work } from "./work-view";

function card(overrides: Partial<StudioWorkCard> = {}): StudioWorkCard {
  return {
    id: "acme-login",
    title: "Acme login",
    intent: "SSO",
    repositories: ["acme/web"],
    implicit: true,
    memberNames: ["acme-login"],
    artifacts: {},
    offers: [],
    needsYou: false,
    bucket: "local",
    claim: { kind: "none" },
    progress: { kind: "none" },
    stage: "human-review",
    stageLabel: "Review proposal",
    sharing: {
      presence: "local",
      missingMembers: [],
      sync: "in-sync",
      stale: false,
      remoteOnly: false,
    },
    members: [
      {
        name: "acme-login",
        stage: "human-review",
        stageLabel: "Review proposal",
        delivered: false,
      },
    ],
    done: false,
    actions: { share: null, "start-manual": null },
    diagnostics: [],
    ...overrides,
  };
}

const SHARED = {
  presence: "shared" as const,
  missingMembers: [],
  sync: "in-sync" as const,
  stale: false,
  remoteOnly: false,
};

function payload(overrides: Partial<StudioWorkPayload> = {}): StudioWorkPayload {
  return {
    writable: true,
    operator: { id: "dev@acme.test", label: "Acme Developer" },
    gitBacked: true,
    team: { remote: "origin", branch: "main", stale: false, fetchedAt: "2026-11-02T11:00:00.000Z" },
    cards: [
      card({
        id: "acme-idea",
        title: "Acme idea",
        bucket: "scratchpad",
        memberNames: [],
        members: [],
        actions: {},
      }),
      card(),
      card({
        id: "acme-taken",
        title: "Acme taken",
        bucket: "remote",
        sharing: SHARED,
        claim: { kind: "other", label: "Acme Teammate", id: "mate@acme.test" },
        actions: { claim: "claimed by Acme Teammate" },
      }),
      card({
        id: "acme-open",
        title: "Acme open",
        bucket: "remote",
        sharing: SHARED,
        actions: { claim: null },
      }),
    ],
    needsYou: 0,
    linkedRepositories: ["acme/web"],
    ticketFormat: "none",
    diagnostics: [],
    ...overrides,
  };
}

const render = (data: StudioWorkPayload, bucket?: StudioWorkCard["bucket"]) =>
  staticMarkup(
    <Work payload={data} search={{ companion: "0123456789", ...(bucket ? { bucket } : {}) }} />,
  );

describe("Work's address", () => {
  it("validates the bucket, dropping unknown values", () => {
    expect(validateWorkSearch({ bucket: "remote" })).toEqual({ bucket: "remote" });
    expect(validateWorkSearch({ bucket: "team" })).toEqual({});
  });
});

describe("Work on a plain installation", () => {
  it("offers Scratchpad, Local work and Remote work", async () => {
    const markup = render(payload());
    for (const label of ["Scratchpad", "Local work", "Remote work"])
      expect(markup).toContain(label);
    expect(markup).toContain("What should we build or improve?");
    expect(markup).toContain(">Save<");
  });

  it("shows each Workset once, in its bucket, with its claim in words", async () => {
    const remote = render(payload(), "remote");
    expect(remote.match(/data-workset="acme-taken"/g)).toHaveLength(1);
    expect(remote).toContain("Claimed by Acme Teammate");
    expect(remote).toContain("Available");
    expect(remote).toContain('data-work-action="claim"');
    const local = render(payload(), "local");
    expect(local).toContain('data-work-action="share"');
    expect(local).toContain('data-work-action="start-manual"');
    // Every lane renders; only its bucket's cards sit in it.
    expect(local.indexOf('data-workset="acme-taken"')).toBeGreaterThan(
      local.indexOf('data-work-lane="remote"'),
    );
    expect(local.indexOf('data-workset="acme-login"')).toBeLessThan(
      local.indexOf('data-work-lane="remote"'),
    );
  });

  it("names progress on a Delivery Branch and the sync state", async () => {
    const markup = render(
      payload({
        cards: [
          card({
            bucket: "remote",
            sharing: SHARED,
            progress: { kind: "elsewhere", branch: "workset/acme-login" },
            actions: { claim: "in progress on workset/acme-login" },
          }),
          card({
            id: "acme-mine",
            claim: { kind: "mine", label: "Acme Developer" },
            sharing: { ...SHARED, sync: "behind" },
          }),
        ],
      }),
      "remote",
    );
    expect(markup).toContain("In progress on workset/acme-login");
    expect(markup).not.toContain("Available");
    const local = render(
      payload({
        cards: [
          card({
            claim: { kind: "mine", label: "Acme Developer" },
            sharing: { ...SHARED, sync: "behind" },
          }),
        ],
      }),
      "local",
    );
    expect(local).toContain("Claimed by you (Acme Developer)");
    expect(local).toContain("The shared version is newer; take it with mate artifact take");
  });

  it("is read-only without the write path: no capture, no actions, no dragging", async () => {
    const scratchpad = render(payload({ writable: false }));
    expect(scratchpad).not.toContain("What should we build or improve?");
    const local = render(payload({ writable: false }), "local");
    expect(local).not.toContain("data-work-action");
    expect(local).not.toContain("data-work-drag");
  });

  it("names stale shared information and the failure", async () => {
    const markup = render(
      payload({
        team: { remote: "origin", branch: "main", stale: true, failure: "could not resolve host" },
      }),
    );
    expect(markup).toContain("Stale: could not resolve host");
  });

  it("shows multi-change progress on one card with its members", async () => {
    const group = card({
      memberNames: ["acme-login-api", "acme-login-ui"],
      members: [
        { name: "acme-login-api", stage: "done", stageLabel: "Done", delivered: true },
        {
          name: "acme-login-ui",
          stage: "propose",
          stageLabel: "Propose",
          delivered: false,
          problem: "neither active nor archived",
        },
      ],
      stage: "propose",
      stageLabel: "Propose",
      diagnostics: ["acme-login-ui: neither active nor archived"],
    });
    const markup = render(payload({ cards: [group] }), "local");
    expect(markup.match(/data-workset="acme-login"/g)).toHaveLength(1);
    expect(markup).toContain("2 changes");
    expect(markup).toContain("acme-login-ui: neither active nor archived");
    expect(markup).not.toContain(">Done<");
  });
});

describe("drag targets", () => {
  it("Local work drops on Remote work to share; available Remote work drops on Local to claim", () => {
    expect(dropTargetsOf(card())).toEqual({ remote: "share" });
    expect(dropTargetsOf(card({ bucket: "remote", actions: { claim: null } }))).toEqual({
      local: "claim",
    });
    expect(dropTargetsOf(card({ bucket: "remote", actions: { claim: "claimed" } }))).toEqual({});
    expect(dropTargetsOf(card({ actions: { share: "read-only" } }))).toEqual({});
  });

  it("your claimed work drops on Remote work to release it; nothing drops on Scratchpad", () => {
    const mine = card({
      claim: { kind: "mine", label: "Acme Developer" },
      actions: { share: null, release: null },
    });
    expect(dropTargetsOf(mine)).toEqual({ remote: "release" });
    expect(dropTargetsOf(card({ bucket: "scratchpad", actions: {} }))).toEqual({});
  });

  it("lays out all three buckets as lanes, with a drag handle only on movable cards", async () => {
    const markup = render(payload());
    for (const lane of ["scratchpad", "local", "remote"])
      expect(markup).toContain(`data-work-lane="${lane}"`);
    expect(markup).toContain('data-work-drag="acme-login"');
    expect(markup).toContain('data-work-drag="acme-open"');
    expect(markup).not.toContain('data-work-drag="acme-taken"');
    expect(markup).not.toContain('data-work-drag="acme-idea"');
    expect(markup).toContain('aria-label="Move Acme login"');
  });

  it("escapes Workset text and keeps a draft across a refetch", async () => {
    const { useWorkUi } = await import("../../stores/work-ui");
    const hostile = card({ title: '<img src=x onerror="alert(1)">', bucket: "local" });
    const markup = render(payload({ cards: [hostile] }), "local");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("&lt;img src=x");
    // Drafts and the open dialog live in the store, not in the payload a refetch replaces.
    useWorkUi.getState().setDraft("0123456789", "Acme unsaved idea");
    useWorkUi.getState().open({ kind: "share", workset: "acme-login" });
    render(payload({ cards: [] }));
    expect(useWorkUi.getState().drafts["0123456789"]).toBe("Acme unsaved idea");
    expect(useWorkUi.getState().dialog).toEqual({ kind: "share", workset: "acme-login" });
    useWorkUi.getState().setDraft("0123456789", "");
    useWorkUi.getState().close();
  });

  it("only accepted actions are offered", () => {
    expect(acceptedActions(card({ actions: { claim: "claimed", share: null } }))).toEqual([
      "share",
    ]);
  });
});
