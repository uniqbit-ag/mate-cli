import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  commitAll,
  git,
  type GitTeam,
  gitTeam,
  write,
  writeChange,
} from "../../../../../../test/workset-git";
import { createStudioAccess } from "./access";
import type { StudioChange, StudioCompanionPayload } from "./payload";
import { companionDigest } from "./selection";
import { createStudioFetch } from "./server";
import type { StudioApp } from "./studio-app";
import type { WorkRequest } from "./work";

let team: GitTeam;
let companion: string;
let teammate: string;
let digest: string;

const complete = (name: string): StudioChange => ({
  name,
  artifacts: ["proposal", "specs", "design", "tasks"].map((id) => ({ id, status: "done" })),
  completedTasks: 0,
});

function link(clone: string): void {
  const working = path.join(team.root, `${path.basename(clone)}-web`);
  fs.mkdirSync(working, { recursive: true });
  git(team.root, "init", "-q", working);
  git(working, "remote", "add", "origin", "https://github.com/acme/web.git");
  write(clone, ".mate/config/registry.yaml", `repos:\n  - id: acme-web\n    path: ${working}\n`);
  fs.appendFileSync(path.join(clone, ".git", "info", "exclude"), ".mate/\n");
}

beforeEach(async () => {
  team = await gitTeam();
  companion = team.clone("author", { name: "Acme Author", email: "author@acme.test" });
  teammate = team.clone("teammate", { name: "Acme Teammate", email: "mate@acme.test" });
  link(companion);
  digest = companionDigest(companion);
});

afterEach(() => team.cleanup());

function handlerFor(options: { writable?: boolean; token?: string; app?: StudioApp } = {}) {
  return createStudioFetch(
    {
      collectStudioInventory: async () => ({
        companions: [{ path: companion, health: "ready", pairings: [] }],
      }),
      assembleCompanionPayload: async (companionPath) => {
        const changes = fs.existsSync(path.join(companionPath, "openspec/changes"))
          ? fs
              .readdirSync(path.join(companionPath, "openspec/changes"))
              .filter((name) => name !== "archive")
              .map(complete)
          : [];
        return {
          companionPath,
          changes,
          specs: [],
          shipped: [],
          topology: null,
          worksets: [],
          linkedRepositories: ["acme/web"],
          ticketFormat: "none",
          worksetProblems: [],
          warnings: [],
          skillInventory: {
            claude: ["mate-apply-change", "mate-explore-change", "mate-propose-change"],
            opencode: [],
            agents: [],
          },
        } as unknown as StudioCompanionPayload;
      },
    },
    {
      writable: options.writable ?? true,
      ...(options.app ? { app: options.app } : {}),
      ...(options.token
        ? {
            access: createStudioAccess({
              invocation: "serve",
              terminal: false,
              hostname: "localhost",
              port: () => 80,
              token: options.token,
            }),
          }
        : {}),
    },
  );
}

const act = (handler: ReturnType<typeof handlerFor>, request: WorkRequest) =>
  handler.services.workAction(digest, request);

describe("Work on a plain installation", () => {
  test("offers Scratchpad, Local work and Remote work", async () => {
    writeChange(companion, "acme-login");
    const handler = handlerFor();
    expect(await act(handler, { action: "capture", text: "Acme audit log." })).toEqual({
      ok: true,
    });
    const work = await handler.services.work(digest);
    const buckets = Object.fromEntries(work.cards.map((card) => [card.id, card.bucket]));
    expect(buckets).toEqual({ "acme-audit-log": "scratchpad", "acme-login": "local" });
    const idea = work.cards.find((card) => card.id === "acme-audit-log")!;
    expect(idea.offers.map((offer) => offer.action)).toEqual([
      "explore-workset",
      "propose-workset",
    ]);
    expect(work.operator).toEqual({ id: "author@acme.test", label: "Acme Author" });
    handler.close();
  });
});

describe("manual continuation", () => {
  test("offers copyable prompts without a terminal; a start writes nothing", async () => {
    writeChange(companion, "acme-login");
    const handler = handlerFor();
    const before = (await handler.services.work(digest)).cards.find(
      (card) => card.id === "acme-login",
    )!;
    expect(before.offers).toEqual([
      {
        action: "apply-change",
        subject: "acme-login",
        label: "Apply",
        prompts: { claude: "/mate-apply-change acme-login" },
        runAgents: [],
      },
    ]);
    const status = git(companion, "status", "--porcelain");
    const started = await act(handler, {
      action: "start-manual",
      workset: "acme-login",
      members: ["acme-login"],
    });
    expect(started).toEqual({ ok: true, prompts: [{ claude: "/mate-apply-change acme-login" }] });
    expect(git(companion, "status", "--porcelain")).toBe(status);
    handler.close();
  });
});

describe("guards", () => {
  test("read-only Studio refuses mutations but may refresh", async () => {
    writeChange(companion, "acme-login");
    const handler = handlerFor({ writable: false });
    expect(await act(handler, { action: "capture", text: "Acme." })).toMatchObject({
      ok: false,
      kind: "access",
    });
    expect(await act(handler, { action: "share-preview", workset: "acme-login" })).toMatchObject({
      ok: false,
      kind: "access",
    });
    expect(await act(handler, { action: "refresh" })).toEqual({ ok: true });
    const work = await handler.services.work(digest);
    for (const card of work.cards) {
      for (const reason of Object.values(card.actions)) expect(reason).toContain("read-only");
    }
    handler.close();
  });

  test("unknown companions and Worksets are refused", async () => {
    const handler = handlerFor();
    await expect(
      handler.services.workAction("0".repeat(digest.length), { action: "refresh" }),
    ).rejects.toThrow("no registered companion");
    expect(
      await act(handler, { action: "start-manual", workset: "acme-nope", members: [] }),
    ).toMatchObject({ ok: false, kind: "prerequisite" });
    handler.close();
  });

  test("a stale claim and another owner's start are refused on the server", async () => {
    writeChange(teammate, "acme-login");
    commitAll(teammate, "propose");
    git(teammate, "push", "-q", "origin", "main");
    git(teammate, "push", "-q", "origin", "HEAD:refs/heads/mate/inbox");
    git(companion, "pull", "-q", "origin", "main");
    const handler = handlerFor();
    await act(handler, { action: "refresh" });
    expect(
      await act(handler, {
        action: "start-manual",
        workset: "acme-login",
        members: ["acme-login"],
      }),
    ).toMatchObject({ ok: false, reason: "claim it first" });
    const stale = await act(handler, {
      action: "claim",
      workset: "acme-login",
      members: ["acme-other"],
      key: "c1",
    });
    expect(stale).toMatchObject({ ok: false, kind: "stale" });

    // The teammate claims it outside this Studio.
    const { updateClaim } = await import("../../../lib/workset/transactions");
    await updateClaim(teammate, {
      action: "claim",
      members: ["acme-login"],
      operator: { id: "mate@acme.test", label: "Acme Teammate" },
      transactionId: "tx-teammate",
    });
    await act(handler, { action: "refresh" });
    const bypass = await act(handler, {
      action: "start-manual",
      workset: "acme-login",
      members: ["acme-login"],
    });
    expect(bypass).toMatchObject({ ok: false, kind: "access", reason: "claimed by Acme Teammate" });
    handler.close();
  });

  test("share preview then a changed artifact makes the confirmation stale", async () => {
    writeChange(companion, "acme-login");
    const handler = handlerFor();
    const preview = await act(handler, { action: "share-preview", workset: "acme-login" });
    if (!preview.ok || !preview.preview) throw new Error(JSON.stringify(preview));
    write(companion, "openspec/changes/acme-login/tasks.md", "- [ ] 1.1 Changed\n");
    const shared = await act(handler, {
      action: "share",
      workset: "acme-login",
      hash: preview.preview.hash,
      key: "share-1",
    });
    expect(shared).toMatchObject({ ok: false, kind: "stale" });
    handler.close();
  });

  test("shared work is available in Remote work until claimed, then it is Local work", async () => {
    writeChange(companion, "acme-login");
    const handler = handlerFor();
    const preview = await act(handler, { action: "share-preview", workset: "acme-login" });
    if (!preview.ok || !preview.preview) throw new Error(JSON.stringify(preview));
    expect(
      await act(handler, {
        action: "share",
        workset: "acme-login",
        hash: preview.preview.hash,
        key: "share-2",
      }),
    ).toEqual({ ok: true });
    const cardOf = async () =>
      (await handler.services.work(digest)).cards.find((entry) => entry.id === "acme-login");
    expect(await cardOf()).toMatchObject({ bucket: "remote", claim: { kind: "none" } });
    expect(
      await act(handler, {
        action: "claim",
        workset: "acme-login",
        members: ["acme-login"],
        key: "c2",
      }),
    ).toEqual({ ok: true });
    await act(handler, { action: "refresh" });
    expect(await cardOf()).toMatchObject({ bucket: "local", claim: { kind: "mine" } });
    handler.close();
  });

  test("claimed work this checkout lacks offers no prompt until it is taken", async () => {
    git(teammate, "switch", "-q", "-c", "mate/inbox");
    writeChange(teammate, "acme-login");
    commitAll(teammate, "propose acme-login");
    git(teammate, "push", "-q", "origin", "mate/inbox");
    const handler = handlerFor();
    expect(await act(handler, { action: "refresh" })).toEqual({ ok: true });
    expect(
      await act(handler, {
        action: "claim",
        workset: "acme-login",
        members: ["acme-login"],
        key: "c3",
      }),
    ).toMatchObject({ ok: true });
    const card = (await handler.services.work(digest)).cards.find(
      (entry) => entry.id === "acme-login",
    );
    expect(card).toMatchObject({ bucket: "local", sharing: { remoteOnly: true }, offers: [] });
    handler.close();
  });

  test("server-function writes need Studio's token and origin before any service runs", async () => {
    let reached = 0;
    const app: StudioApp = {
      clientDir: team.root,
      fetch: async () => {
        reached += 1;
        return new Response("ok");
      },
    };
    const handler = handlerFor({ token: "acme-token", app });
    const call = (headers: Record<string, string>) =>
      handler(
        new Request("http://localhost/_serverFn/work", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{}",
        }),
      );
    expect((await call({ origin: "http://localhost" }))?.status).toBe(401);
    expect(
      (await call({ origin: "http://evil.test", cookie: "mate_studio_80=acme-token" }))?.status,
    ).toBe(403);
    expect(reached).toBe(0);
    handler.close();
  });
});
