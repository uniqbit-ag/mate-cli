import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FactoryRunner } from "../runner/scheduler";
import { RunStore } from "../runner/state";
import { Run } from "../runner/run";
import { FactoryError } from "../ids";
import type { WorksetInfo } from "../runtime";
import { readWorksetStages } from "../../workset/stages";
import type { WorksetRecord } from "../../workset/record";
import {
  doneWorksetsFrom,
  factoryGitEnv,
  pickUpReady,
  reclaimDone,
  requireAgentCredential,
  runnerLimits,
  storeReviewReport,
} from "./lifecycle";

describe("the runner's limits", () => {
  test("default to two runs, a build cap of every run, and sixty minutes", () => {
    expect(runnerLimits({})).toEqual({ maxRuns: 2, maxBuilds: 2, stageMs: 60 * 60_000 });
  });

  test("read the build cap from MATE_FACTORY_PARALLEL_BUILDS", () => {
    expect(
      runnerLimits({ MATE_FACTORY_MAX_RUNS: "8", MATE_FACTORY_PARALLEL_BUILDS: "2" }),
    ).toMatchObject({ maxRuns: 8, maxBuilds: 2 });
  });
});

describe("an agent turn without a credential", () => {
  test("is refused naming the Agents panel", async () => {
    await expect(
      requireAgentCredential({ info: async () => ({ credential: null }) }),
    ).rejects.toThrow(/Agents panel/);
    await requireAgentCredential({ info: async () => ({ credential: "api-key" }) });
  });
});

describe("the factory's Git author", () => {
  test("is Mate factory by default, as author and committer", () => {
    expect(factoryGitEnv({})).toEqual({
      GIT_AUTHOR_NAME: "Mate factory",
      GIT_AUTHOR_EMAIL: "factory@mate.invalid",
      GIT_COMMITTER_NAME: "Mate factory",
      GIT_COMMITTER_EMAIL: "factory@mate.invalid",
    });
  });

  test("is the operator's bot account when one is named", () => {
    expect(
      factoryGitEnv({
        MATE_FACTORY_GIT_NAME: "acme-mate-bot",
        MATE_FACTORY_GIT_EMAIL: "mate-bot@acme.test",
      }),
    ).toMatchObject({
      GIT_AUTHOR_NAME: "acme-mate-bot",
      GIT_COMMITTER_EMAIL: "mate-bot@acme.test",
    });
  });

  test("ignores blank values", () => {
    expect(factoryGitEnv({ MATE_FACTORY_GIT_NAME: " ", MATE_FACTORY_GIT_EMAIL: "" })).toMatchObject(
      { GIT_AUTHOR_NAME: "Mate factory", GIT_AUTHOR_EMAIL: "factory@mate.invalid" },
    );
  });
});

describe("pickup", () => {
  let companion: string;
  let runs: Run;

  beforeEach(() => {
    companion = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-pickup-")));
    fs.mkdirSync(path.join(companion, "worksets"));
    runs = new Run(new RunStore(path.join(companion, "runs")));
  });

  afterEach(() => fs.rmSync(companion, { recursive: true, force: true }));

  function workset(id: string, fields: string): void {
    fs.writeFileSync(
      path.join(companion, "worksets", `${id}.yaml`),
      `id: ${id}\nrepositories: [acme/web]\n${fields}`,
    );
  }

  function fakeRunner(active: string[] = []) {
    const requests: [string, string][] = [];
    const runner = {
      isActive: (id: string) => active.includes(id),
      pickUp: async (id: string, stage: string) => {
        requests.push([id, stage]);
        return true;
      },
    } as unknown as FactoryRunner;
    return { runner, requests };
  }

  const pick = (runner: FactoryRunner, busy: string[] = []) =>
    pickUpReady({
      runner,
      companionPath: companion,
      busy: () => new Set(busy),
    });

  test("a ready started Outcome is proposed, in rank order", async () => {
    workset("acme-a", "stage: ready\nqueuedAt: 2026-11-02T10:00:00.000Z\n");
    workset("acme-b", "stage: ready\nqueuedAt: 2026-11-02T09:00:00.000Z\n");
    const { runner, requests } = fakeRunner();
    await pick(runner);
    expect(requests).toEqual([
      ["acme-b", "propose"],
      ["acme-a", "propose"],
    ]);
  });

  test("a ready Later Outcome waits", async () => {
    workset("acme-later", "stage: ready\n");
    const { runner, requests } = fakeRunner();
    await pick(runner);
    expect(requests).toEqual([]);
  });

  test("an Outcome moved to Later after the list was read is not requested", async () => {
    workset("acme-a", "stage: ready\nqueuedAt: 2026-11-02T09:00:00.000Z\n");
    const requested: string[] = [];
    const runner = {
      isActive: () => false,
      pickUp: async (id: string, _stage: string, pickable: () => Promise<boolean>) => {
        workset("acme-a", "stage: ready\n");
        if (!(await pickable())) return false;
        requested.push(id);
        return true;
      },
    } as unknown as FactoryRunner;
    expect(await pick(runner)).toEqual([]);
    expect(requested).toEqual([]);
  });

  test("an active run is left alone", async () => {
    workset("acme-b", "stage: ready\nqueuedAt: 2026-11-02T09:00:00.000Z\n");
    const { runner, requests } = fakeRunner(["acme-b"]);
    await pick(runner);
    expect(requests).toEqual([]);
  });

  test("a started Outcome at Clarify intent starts clarify, and Explore change starts explore", async () => {
    workset("acme-a", "stage: clarify-intent\nqueuedAt: 2026-11-02T09:00:00.000Z\n");
    workset("acme-b", "stage: explore\nqueuedAt: 2026-11-02T10:00:00.000Z\n");
    const { runner, requests } = fakeRunner();
    await pick(runner);
    expect(requests).toEqual([
      ["acme-a", "clarify"],
      ["acme-b", "explore"],
    ]);
  });

  test("a Workset with a live session is left to the person", async () => {
    workset("acme-a", "stage: explore\nqueuedAt: 2026-11-02T09:00:00.000Z\n");
    const { runner, requests } = fakeRunner();
    await pick(runner, ["acme-a"]);
    expect(requests).toEqual([]);
  });
});

describe("review reports", () => {
  test("a produced report moves into the report store and its id is remembered", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-review-")));
    const companion = path.join(root, "acme-companion");
    fs.mkdirSync(companion);
    const runs = new Run(new RunStore(path.join(root, "runs")));
    const published: Array<{ title: string; html: string }> = [];
    const reports = {
      publish: async (report: { title: string; html: string }) => {
        published.push(report);
        return { id: "report-1" };
      },
      ids: async () => ["report-1"],
    };
    const file = path.join(root, "repos", "acme__web", ".git", "mate-factory", "review.html");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "<html>review</html>");

    await storeReviewReport(runs, reports, "acme-login", "acme-login-a", file);

    expect(published).toEqual([{ title: "Review acme-login-a", html: "<html>review</html>" }]);
    expect((await runs.facts("acme-login")).memory.reviewReports).toEqual({
      "acme-login-a": "report-1",
    });
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("reclaim at Done", () => {
  let dir: string;
  let runs: Run;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-reclaim-")));
    runs = new Run(new RunStore(path.join(dir, "runs")));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const info = (id: string, state: WorksetInfo["state"] = "paused"): WorksetInfo => ({
    id,
    repository: "acme/web",
    branch: `workset/${id}`,
    state,
  });

  function deps(options: { refuse?: string; active?: string[]; busy?: string[] } = {}) {
    const deleted: Array<[string, unknown]> = [];
    const refused = new Set<string>();
    return {
      deleted,
      refused,
      deps: {
        client: {
          list: async () => [info("acme-done"), info("acme-ready", "running"), info("acme-gone")],
          delete: async (id: string, force?: unknown) => {
            if (id === options.refuse) {
              throw new FactoryError(
                `Workset ${id} has 1 unpushed commit(s) (abc0 Add the signup step); push them or delete with force`,
              );
            }
            deleted.push([id, force]);
          },
        },
        runs,
        runner: { isActive: (id: string) => (options.active ?? []).includes(id) },
        doneWorksets: async () => ["acme-done", "acme-old"],
        busy: () => new Set(options.busy ?? []),
        refused,
      },
    };
  }

  test("removes a Done Workset's container, worktree and run files without force", async () => {
    await runs.settle("acme-done");
    await runs.rememberPush("acme-done", "workset/acme-done");
    await runs.log("acme-done", "published\n");
    const { deps: d, deleted } = deps();

    expect(await reclaimDone(d)).toEqual(["acme-done"]);
    // Only Done Worksets that still hold something; acme-old has neither container nor worktree.
    expect(deleted).toEqual([["acme-done", undefined]]);
    expect(await runs.facts("acme-done")).toMatchObject({
      recorded: false,
      memory: {},
      hasLog: false,
    });
  });

  test("a refusal for unpushed work keeps everything and names the commit on the card", async () => {
    await runs.settle("acme-done");
    const execution = (await runs.facts("acme-done")).execution;
    const { deps: d, deleted, refused } = deps({ refuse: "acme-done" });

    expect(await reclaimDone(d)).toEqual([]);
    expect(deleted).toEqual([]);
    expect((await runs.facts("acme-done")).execution).toEqual(execution);
    const situation = (await runs.facts("acme-done")).memory.situations?.[0];
    expect(situation?.text).toContain("abc0 Add the signup step");
    expect(refused.has("acme-done")).toBe(true);

    // Not retried until the next publication.
    await reclaimDone(d);
    expect((await runs.facts("acme-done")).memory.situations).toHaveLength(1);
    await reclaimDone(d, "acme-done");
    expect((await runs.facts("acme-done")).memory.situations).toHaveLength(2);
  });

  test("reads Done from the companion itself and keeps a Workset at the Human Reviews", async () => {
    const record = (id: string, changes: string[]): WorksetRecord => ({
      id,
      title: id,
      intent: "",
      repositories: ["acme/web"],
      changes,
      stage: "ready",
      createdAt: "",
      extra: {},
    });
    const doneWorksets = doneWorksetsFrom(() =>
      readWorksetStages("/companions/acme", {
        readWorksets: async () => ({
          worksets: [record("acme-done", ["acme-shipped"]), record("acme-ready", ["acme-review"])],
          problems: [],
        }),
        activeChanges: async () => [
          { name: "acme-review", artifacts: [{ id: "specs", status: "done" }] },
        ],
        publishedAnchors: async () => ["2026-10-01-acme-shipped"],
        archiveAnchors: async () => ["2026-10-01-acme-shipped"],
        archiveMergeSettled: async () => true,
      }),
    );
    const { deps: d, deleted } = deps();

    expect(await reclaimDone({ ...d, doneWorksets })).toEqual(["acme-done"]);
    expect(deleted).toEqual([["acme-done", undefined]]);
  });

  test("leaves a Workset with a run or a live session alone", async () => {
    expect(await reclaimDone(deps({ active: ["acme-done"] }).deps)).toEqual([]);
    expect(await reclaimDone(deps({ busy: ["acme-done"] }).deps)).toEqual([]);
  });
});
