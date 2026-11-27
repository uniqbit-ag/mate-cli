import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunOpenSpec } from "../openspec-cli";
import type { WorkingRepoGit } from "./branches";
import type { DeliveryEnvironment } from "./environment";
import {
  DELIVERY_FILE,
  readDeliveryRecord,
  unlinkedRecord,
  upsertDelivery,
  writeDeliveryRecord,
} from "./record";
import { groupOfChange, type GroupSubmission, type submitGroups } from "./staging/submit";
import { WORKFLOW_FILE } from "../workflow/declaration";
import {
  submitChanges,
  type SubmitChangeDeps,
  type SubmitRequest,
  type SubmitResult,
} from "./submit-change";

const REPO = "acme/acme-app";
const GROUP = "acme_acme-app/workset/acme-login";
let companion: string;
let calls: string[];
let pushedGroups: { names: readonly string[] }[];

const changeDir = (name: string) => path.join(companion, "openspec", "changes", name);

function repoGit(existing: string[] = []): WorkingRepoGit {
  return {
    currentBranch: async () => "change/x",
    defaultBranch: async () => "main",
    remoteUrl: async () => "https://github.com/acme/acme-app.git",
    unpushedCommits: async () => [],
    branchExists: async (branch) => existing.includes(branch),
    hasRef: async (ref) => existing.some((branch) => ref === `refs/heads/${branch}`),
  };
}

function environment(
  overrides: { existing?: string[]; slug?: string | null } = {},
): DeliveryEnvironment {
  const slug = overrides.slug === undefined ? REPO : overrides.slug;
  return {
    companionPath: companion,
    workingRepo: {
      path: "/repo",
      slug,
      git: repoGit(overrides.existing),
    },
    protectedPatterns: [],
  };
}

/** Status fails; `validate` passes unless `invalid` names the change. */
function fakeOpenSpec(invalid: string[] = []): RunOpenSpec {
  return async (args) => {
    calls.push(args[0]);
    if (args[0] === "status") return { code: 1, stdout: "", stderr: "no status" };
    if (args[0] === "validate" && invalid.includes(args.at(-1)!)) {
      return { code: 1, stdout: "", stderr: `${args.at(-1)}: invalid delta` };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function withStatus(artifacts: Record<string, string>): RunOpenSpec {
  return async (args, options) => {
    if (args[0] !== "status") return fakeOpenSpec()(args, options);
    calls.push("status");
    const stdout = JSON.stringify({
      schemaName: "mate-full",
      artifacts: Object.entries(artifacts).map(([id, status]) => ({ id, status })),
    });
    return { code: 0, stdout, stderr: "" };
  };
}

/** Records the push request; answers as `status` for every group. */
function fakeGroups(status: GroupSubmission["status"] = "pushed"): typeof submitGroups {
  return async (companionPath, names) => {
    pushedGroups.push({ names });
    calls.push("push");
    const failed = status === "failed";
    const groups = new Set<string>();
    for (const name of names) groups.add((await groupOfChange(companionPath, name)).group);
    return [...groups].map((group) => ({
      group,
      status,
      waitingFor: status === "waiting" ? ["acme-login-ui"] : [],
      push: {
        group,
        changes: [...names],
        status: failed ? "failed" : status === "unchanged" ? "unchanged" : "pushed",
        commit: status === "pushed" ? "c0ffee" : null,
        pendingBranch: "main",
        ...(failed ? { reason: "push-failed" as const, detail: "offline" } : {}),
      },
    }));
  };
}

/** A change folder whose every task is checked, so its stages before submit are done. */
async function finished(name: string): Promise<void> {
  await fs.mkdir(changeDir(name), { recursive: true });
  await fs.writeFile(path.join(changeDir(name), "tasks.md"), "- [x] 1.1 Acme\n");
}

async function declare(source: string): Promise<void> {
  await fs.mkdir(path.join(companion, ".mate", "config"), { recursive: true });
  await fs.writeFile(path.join(companion, WORKFLOW_FILE), source);
}

async function linkBranch(name: string, branch = "workset/acme-login"): Promise<void> {
  await finished(name);
  await writeDeliveryRecord(
    changeDir(name),
    upsertDelivery(unlinkedRecord(name), REPO, { branch }),
  );
}

async function submit(
  request: Partial<SubmitRequest> = {},
  deps: SubmitChangeDeps = {},
  env: DeliveryEnvironment = environment(),
): Promise<SubmitResult> {
  const outcome = await submitChanges(
    env,
    { changes: ["x"], ...request },
    {
      now: () => new Date("2026-10-28T10:00:00.000Z"),
      runOpenSpec: fakeOpenSpec(),
      submitGroups: fakeGroups(),
      preflightGroup: async () => ({ status: "passed" }),
      ...deps,
    },
  );
  if (!("results" in outcome)) throw new Error(`refused: ${outcome.refusal.reason}`);
  return outcome.results[0]!;
}

async function stateOf(change: string): Promise<string | undefined> {
  return (await readDeliveryRecord(changeDir(change)))?.state;
}

async function dependOnActiveChange(): Promise<void> {
  await fs.writeFile(path.join(changeDir("x"), "proposal.md"), "---\ndependsOn: [a]\n---\n");
  await fs.mkdir(changeDir("a"), { recursive: true });
}

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "submit-change-"));
  await finished("x");
  calls = [];
  pushedGroups = [];
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
});

describe("submitChanges", () => {
  test("a linked, unmerged change is submitted, its PR reported as waiting", async () => {
    await linkBranch("x");
    const result = await submit();
    expect(result).toMatchObject({
      status: "submitted",
      group: GROUP,
      pushed: true,
      commit: "c0ffee",
      pendingBranch: "main",
      state: "submitted",
      settlement: { status: "waiting" },
    });
    expect(pushedGroups).toEqual([{ names: ["x"] }]);
    // The push sets the local state, once it succeeded.
    expect(await stateOf("x")).toBeUndefined();
    // Nothing archived: the folder stays where it is.
    await expect(fs.access(changeDir("x"))).resolves.toBeNull();
  });

  test("the check runs before the group is pushed", async () => {
    await linkBranch("x");
    await submit();
    expect(calls).toEqual(["status", "validate", "push"]);
  });

  test("a failing check pushes nothing and leaves the change active", async () => {
    await linkBranch("x");
    const result = await submit({}, { runOpenSpec: fakeOpenSpec(["x"]) });
    expect(result).toMatchObject({ status: "failed", reason: "check-failed", pushed: false });
    expect(result.message).toContain("invalid delta");
    expect(calls).not.toContain("push");
    expect(await stateOf("x")).toBeUndefined();
  });

  test("a failing check keeps its whole group from being pushed", async () => {
    await linkBranch("x");
    await linkBranch("y");
    const outcome = await submitChanges(
      environment(),
      { changes: ["x", "y"] },
      { runOpenSpec: fakeOpenSpec(["x"]), submitGroups: fakeGroups() },
    );
    if (!("results" in outcome)) throw new Error("refused");
    expect(outcome.results[0]).toMatchObject({ change: "x", status: "failed", state: "active" });
    expect(outcome.results[1]).toMatchObject({
      change: "y",
      status: "waiting",
      waitingFor: ["x"],
      state: "active",
    });
    expect(pushedGroups).toEqual([]);
    expect(await stateOf("y")).toBeUndefined();
  });

  test("holdPush records and checks but pushes nothing", async () => {
    await linkBranch("x");
    const result = await submit(
      { holdPush: true },
      { preflightGroup: async () => ({ status: "failed", change: "x", message: "refused" }) },
    );
    expect(result).toMatchObject({ status: "waiting", waitingFor: [], state: "active" });
    expect(result.message).toBe("Checked x; nothing was pushed.");
    expect(calls).toEqual(["status", "validate"]);
    expect(pushedGroups).toEqual([]);
  });

  test("a waiting group reports the members it waits for and changes no state", async () => {
    await linkBranch("x");
    const result = await submit({}, { submitGroups: fakeGroups("waiting") });
    expect(result).toMatchObject({
      status: "waiting",
      waitingFor: ["acme-login-ui"],
      pushed: false,
      state: "active",
    });
    expect(result.message).toContain("waits for: acme-login-ui");
    expect(await stateOf("x")).toBeUndefined();
  });

  test("a sibling of the group with every task checked is submitted with it", async () => {
    await linkBranch("x");
    await linkBranch("y");
    await fs.writeFile(path.join(changeDir("y"), "tasks.md"), "- [x] 1.1 Acme\n");
    const outcome = await submitChanges(
      environment(),
      { changes: ["x"] },
      { runOpenSpec: fakeOpenSpec(), submitGroups: fakeGroups() },
    );
    if (!("results" in outcome)) throw new Error("refused");
    expect(pushedGroups).toEqual([{ names: ["x", "y"] }]);
    expect(outcome.results.map((result) => [result.change, result.status])).toEqual([
      ["x", "submitted"],
      ["y", "submitted"],
    ]);
  });

  test("a sibling with open tasks is not submitted, so its group waits for it", async () => {
    await linkBranch("x");
    await linkBranch("y");
    await fs.writeFile(path.join(changeDir("y"), "tasks.md"), "- [x] 1.1 Acme\n- [ ] 1.2 Acme\n");
    const outcome = await submitChanges(
      environment(),
      { changes: ["x"] },
      { runOpenSpec: fakeOpenSpec(), submitGroups: fakeGroups("waiting") },
    );
    if (!("results" in outcome)) throw new Error("refused");
    // The group push itself answers `waiting` for the active member left out.
    expect(pushedGroups).toEqual([{ names: ["x"] }]);
    expect(outcome.results.map((result) => result.change)).toEqual(["x"]);
    expect(outcome.results[0]).toMatchObject({ status: "waiting", state: "active" });
  });

  test("a sibling in another group is left alone", async () => {
    await linkBranch("x");
    await linkBranch("y", "workset/acme-search");
    await submit();
    expect(pushedGroups).toEqual([{ names: ["x"] }]);
  });

  test("a failed push fails the submit and changes no state", async () => {
    await linkBranch("x");
    const result = await submit({}, { submitGroups: fakeGroups("failed") });
    expect(result).toMatchObject({
      status: "failed",
      reason: "push-failed",
      state: "active",
      pushed: false,
    });
    expect(await stateOf("x")).toBeUndefined();
  });

  test("an unchanged resubmit reports no push", async () => {
    await linkBranch("x");
    const result = await submit({}, { submitGroups: fakeGroups("unchanged") });
    expect(result).toMatchObject({ status: "submitted", pushed: false, commit: null });
  });

  test("results keep the order of the changes", async () => {
    await finished("y");
    const outcome = await submitChanges(
      environment(),
      { changes: ["y", "x"], skipBranch: true },
      {
        runOpenSpec: fakeOpenSpec(["y"]),
        submitGroups: fakeGroups(),
      },
    );
    if (!("results" in outcome)) throw new Error("refused");
    expect(outcome.results.map((result) => [result.change, result.status, result.group])).toEqual([
      ["y", "failed", "change/y"],
      ["x", "submitted", "change/x"],
    ]);
    expect(pushedGroups).toEqual([{ names: ["x"] }]);
  });

  test("safe Workset default precedes legacy suggestion", async () => {
    const result = await submit({}, {}, environment({ existing: ["change/x", "workset/x"] }));
    expect(result).toMatchObject({
      status: "needs-branch",
      defaultBranch: "workset/x",
      suggestedBranch: "workset/x",
      diagnostics: [],
      group: null,
    });
    expect(calls).not.toContain("push");
  });

  test("regrouping keeps the recorded delivery through submit", async () => {
    await linkBranch("x", "workset/x");
    await fs.mkdir(path.join(companion, ".mate/scratchpad"), { recursive: true });
    await fs.writeFile(
      path.join(companion, ".mate/scratchpad/acme-login.yaml"),
      `id: acme-login\nrepositories: [${REPO}]\nchanges: [x]\n`,
    );
    const result = await submit();
    expect(result.defaultBranch).toBe("workset/x");
    expect(await fs.readFile(path.join(changeDir("x"), DELIVERY_FILE), "utf8")).toContain(
      "workset/x",
    );
  });

  test("recording another repository's branch still refreshes every delivery", async () => {
    const other = "acme/acme-web";
    await linkBranch("x", "change/x");
    const result = await submit({
      repository: other,
      delivery: { branch: "change/x", direct: false },
    });
    expect(result.outcomes.map((outcome) => outcome.repository)).toEqual([REPO, other]);
  });

  test("an unlinked change answers needs-branch, suggesting the existing default branch", async () => {
    const result = await submit({}, {}, environment({ existing: ["change/x"] }));
    expect(result).toMatchObject({ status: "needs-branch", suggestedBranch: "change/x" });
    expect(calls).not.toContain("validate");
    expect(await stateOf("x")).toBeUndefined();
  });

  test("a delivery branch is recorded before submitting", async () => {
    const result = await submit({ delivery: { branch: "change/x", direct: false } });
    expect(result.record.deliveries[0]).toEqual({ repository: REPO, branch: "change/x" });
    expect(result.group).toBe("acme_acme-app/change/x");
  });

  test("the default branch is refused unless it is a direct delivery", async () => {
    const outcome = await submitChanges(
      environment(),
      { changes: ["x"], delivery: { branch: "main", direct: false } },
      { runOpenSpec: fakeOpenSpec() },
    );
    expect(outcome).toEqual({
      refusal: { reason: "protected-branch", branch: "main", protection: "default" },
    });
    expect(calls).toEqual([]);
    const result = await submit({ delivery: { branch: "main", direct: true } });
    expect(result.record.deliveries[0]).toMatchObject({ branch: "main", direct: true });
  });

  test("skipBranch submits with an unlinked record in a group of its own", async () => {
    const result = await submit({ skipBranch: true });
    expect(result).toMatchObject({
      status: "submitted",
      group: "change/x",
      settlement: { status: "unlinked" },
    });
    expect(pushedGroups).toEqual([{ names: ["x"] }]);
  });

  test("an explicit repository is recorded when the Working Repository has no remote", async () => {
    const result = await submit(
      { repository: REPO, delivery: { branch: "change/x", direct: false } },
      {},
      environment({ slug: null }),
    );
    expect(result.status).toBe("submitted");
    expect(result.record.deliveries[0]).toEqual({ repository: REPO, branch: "change/x" });
  });

  test("an unknown change is refused before OpenSpec runs", async () => {
    const outcome = await submitChanges(environment(), { changes: ["nope"] }, {});
    expect(outcome).toEqual({ refusal: { reason: "unknown-change", change: "nope" } });
    expect(calls).toEqual([]);
  });

  test("a refused later change leaves an earlier one unsubmitted and pushes nothing", async () => {
    await linkBranch("x");
    const deliveryFile = path.join(changeDir("x"), DELIVERY_FILE);
    const before = await fs.readFile(deliveryFile, "utf8");
    const outcome = await submitChanges(
      environment(),
      { changes: ["x", "nope"] },
      { runOpenSpec: fakeOpenSpec(), submitGroups: fakeGroups() },
    );
    expect(outcome).toEqual({ refusal: { reason: "unknown-change", change: "nope" } });
    expect(await stateOf("x")).toBeUndefined();
    expect(await fs.readFile(deliveryFile, "utf8")).toBe(before);
    expect(pushedGroups).toEqual([]);
  });

  test("a refused later change leaves an earlier one's delivery unrecorded", async () => {
    await linkBranch("x");
    const deliveryFile = path.join(changeDir("x"), DELIVERY_FILE);
    const before = await fs.readFile(deliveryFile, "utf8");
    const outcome = await submitChanges(
      environment(),
      {
        changes: ["x", "nope"],
        delivery: { branch: "workset/acme-next", direct: false },
      },
      { runOpenSpec: fakeOpenSpec(), submitGroups: fakeGroups() },
    );
    expect(outcome).toEqual({ refusal: { reason: "unknown-change", change: "nope" } });
    expect(await fs.readFile(deliveryFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
    expect(pushedGroups).toEqual([]);
  });

  describe("an unfinished stage", () => {
    const CHAINED = `version: 1
stages:
  - id: discover
    optional: true
    steps: [{ skill: acme-discover }]
  - id: apply
    steps: [{ skill: mate-apply-change }, { skill: acme-verify }]
  - id: submit
    artifact: openspec
    steps: [{ skill: acme-pr-check }, { skill: mate-submit-change }]
  - id: publish
    steps: [{ skill: mate-publish-artifact }]
`;

    const record = (name: string, stages: Record<string, string[]>): Promise<void> =>
      writeDeliveryRecord(changeDir(name), {
        ...upsertDelivery(unlinkedRecord(name), REPO, { branch: "workset/acme-login" }),
        stages,
      });

    const DONE = { apply: ["mate-apply-change", "acme-verify"], submit: ["acme-pr-check"] };

    const stageWarnings = (result: SubmitResult): string[] =>
      result.warnings.flatMap((warning) =>
        warning.kind === "stage-open" ? [warning.message] : [],
      );
    const countedWarnings = (result: SubmitResult): string[] =>
      result.warnings.flatMap((warning) =>
        warning.kind === "step-counted" ? [warning.message] : [],
      );

    test("open tasks on the default path are submitted with a warning", async () => {
      await linkBranch("x");
      await fs.writeFile(
        path.join(changeDir("x"), "tasks.md"),
        "- [x] 1.1 Acme\n- [ ] 1.2 Acme\n- [ ] 1.3 Acme\n",
      );

      const result = await submit();

      expect(result).toMatchObject({ status: "submitted", pushed: true });
      expect(result.warnings).toEqual([
        {
          kind: "stage-open",
          change: "x",
          stage: "apply",
          message:
            "submitting x leaves apply unfinished (2 tasks open); to finish it, run /mate-apply-change x and submit again.",
        },
      ]);
      expect(calls).toEqual(["status", "validate", "push"]);
    });

    test("no tasks on the default path names propose", async () => {
      await linkBranch("x");
      await fs.rm(path.join(changeDir("x"), "tasks.md"));

      const result = await submit();

      expect(result.status).toBe("submitted");
      expect(stageWarnings(result)).toEqual([
        "submitting x leaves propose unfinished (no tasks); to finish it, run /mate-propose-change x and submit again.",
      ]);
    });

    test("an unreported step of a chain is counted and named, with no stage-open", async () => {
      await declare(CHAINED);
      await finished("x");
      await record("x", { apply: ["mate-apply-change"], submit: ["acme-pr-check"] });

      const result = await submit();

      expect(result).toMatchObject({ status: "submitted", pushed: true });
      expect(stageWarnings(result)).toEqual([]);
      expect(result.warnings).toEqual([
        {
          kind: "step-counted",
          change: "x",
          steps: { apply: ["acme-verify"] },
          message:
            "submitting x counts /acme-verify as done, never reported; if one did not run, run it for x and submit again.",
        },
      ]);
    });

    test("a check before mate-submit-change is counted", async () => {
      await declare(CHAINED);
      await finished("x");
      await record("x", { apply: DONE.apply });

      const result = await submit();

      expect(result.status).toBe("submitted");
      expect(countedWarnings(result)).toEqual([
        "submitting x counts /acme-pr-check as done, never reported; if one did not run, run it for x and submit again.",
      ]);
    });

    test("a stage whose plan is open is named by stage-open, its steps not counted", async () => {
      await declare(CHAINED);
      await linkBranch("x");
      await fs.writeFile(path.join(changeDir("x"), "tasks.md"), "- [x] 1.1 Acme\n- [ ] 1.2 Acme\n");
      await record("x", { submit: ["acme-pr-check"] });

      const result = await submit();

      expect(result.warnings.map((warning) => warning.kind)).toEqual(["stage-open"]);
    });

    test("every stage finished gives no warning, an optional stage left out", async () => {
      await declare(CHAINED);
      await finished("x");
      await record("x", DONE);

      expect(await submit()).toMatchObject({ status: "submitted", pushed: true, warnings: [] });
    });

    test("the warning reaches onWarnings before the check", async () => {
      await linkBranch("x");
      await fs.writeFile(path.join(changeDir("x"), "tasks.md"), "- [ ] 1.1 Acme\n");
      const shown: string[] = [];

      await submit(
        {},
        { onWarnings: (_change, warnings) => shown.push(...warnings.map((each) => each.kind)) },
      );

      expect(shown).toEqual(["stage-open"]);
    });

    test("a sibling with an unreported step is submitted with its own warning", async () => {
      await declare(CHAINED);
      await finished("x");
      await record("x", DONE);
      await finished("y");
      await record("y", { apply: ["mate-apply-change"] });

      const outcome = await submitChanges(
        environment(),
        { changes: ["x"] },
        { runOpenSpec: fakeOpenSpec(), submitGroups: fakeGroups() },
      );
      if (!("results" in outcome)) throw new Error("refused");

      expect(pushedGroups).toEqual([{ names: ["x", "y"] }]);
      expect(
        outcome.results.map((result) => [result.change, countedWarnings(result).length]),
      ).toEqual([
        ["x", 0],
        ["y", 1],
      ]);
    });

    test("the deprecated archive alias warns the same way", async () => {
      await linkBranch("x");
      await fs.writeFile(path.join(changeDir("x"), "tasks.md"), "- [ ] 1.1 Acme\n");

      const result = await submit({ holdPush: true });

      expect(result.status).toBe("waiting");
      expect(stageWarnings(result)).toHaveLength(1);
      // Shown before the push, so it never claims the change was submitted.
      expect(stageWarnings(result)[0]).not.toContain("is submitted");
    });

    test("an invalid declaration stops the submit, naming its problems", async () => {
      await declare("version: 1\npublishing: {}\n");
      await linkBranch("x");

      await expect(submit()).rejects.toThrow("publishing: unknown key");
    });
  });

  describe("warnings", () => {
    test("reach onWarnings before the check and the push", async () => {
      await dependOnActiveChange();
      const order: string[] = [];
      const result = await submit(
        { skipBranch: true },
        {
          onWarnings: (_change, warnings) => order.push(...warnings.map((warning) => warning.kind)),
          runOpenSpec: async (args, options) => {
            if (args[0] === "validate") order.push("validate");
            return fakeOpenSpec()(args, options);
          },
        },
      );
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: "dependency", change: "a" }),
      ]);
      expect(order).toEqual(["dependency", "validate"]);
    });

    test("a branch that is no branch name is warned about and grouped by change", async () => {
      await linkBranch("x", "../../tmp/acme");
      const shown: string[] = [];
      const result = await submit(
        {},
        { onWarnings: (_change, warnings) => shown.push(...warnings.map((each) => each.kind)) },
      );
      expect(result.group).toBe("change/x");
      expect(shown).toEqual(["group"]);
    });

    test("a needs-branch result carries warnings without calling onWarnings", async () => {
      await dependOnActiveChange();
      let called = false;
      const result = await submit({}, { onWarnings: () => (called = true) });
      expect(result.status).toBe("needs-branch");
      expect(result.warnings).toHaveLength(1);
      expect(called).toBe(false);
    });

    test("a failed check keeps the warnings", async () => {
      await dependOnActiveChange();
      let shown = 0;
      const result = await submit(
        { skipBranch: true },
        {
          onWarnings: (_change, warnings) => (shown = warnings.length),
          runOpenSpec: fakeOpenSpec(["x"]),
        },
      );
      expect(result).toMatchObject({ status: "failed" });
      expect(result.warnings).toHaveLength(1);
      expect(shown).toBe(1);
    });

    test("unscoped deliveries reach onWarnings", async () => {
      await fs.writeFile(
        path.join(changeDir("x"), "proposal.md"),
        "---\nscopes:\n  - repository: acme/platform/api\n    area: .\n---\n",
      );
      await writeDeliveryRecord(
        changeDir("x"),
        upsertDelivery(unlinkedRecord("x"), "platform/api", { branch: "change/x" }),
      );
      let unscoped: unknown;
      await submit({}, { onWarnings: (_change, _warnings, entries) => (unscoped = entries) });
      expect(unscoped).toEqual([{ repository: "platform/api", closest: "acme/platform/api" }]);
    });
  });

  describe("incomplete planning", () => {
    test("artifacts neither done nor skipped are warned about", async () => {
      const result = await submit(
        { skipBranch: true },
        {
          runOpenSpec: withStatus({
            proposal: "done",
            specs: "done",
            design: "ready",
            tasks: "done",
          }),
        },
      );
      expect(result.status).toBe("submitted");
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: "incomplete-planning", artifacts: ["design"] }),
      ]);
    });

    test("complete planning adds no warning", async () => {
      const result = await submit(
        { skipBranch: true },
        { runOpenSpec: withStatus({ specs: "done", tasks: "done" }) },
      );
      expect(result.warnings).toEqual([]);
    });

    test("an unreadable status submits without the warning", async () => {
      const result = await submit({ skipBranch: true });
      expect(result).toMatchObject({ status: "submitted", warnings: [] });
    });
  });
});
