import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import type { CommandResult } from "../command";
import { unlinkedRecord, upsertDelivery, writeDeliveryRecord } from "../../delivery/record";
import { FactoryRunner } from "./scheduler";
import { Run } from "./run";
import { RunStore } from "./state";
import {
  applyMessage,
  applyStage,
  inDependencyOrder,
  memorySizeFor,
  PROMPTS,
  type StageAgent,
  type TurnOutcome,
  type WorkflowDeps,
} from "./workflow";

let root: string;
let companion: string;
let runs: Run;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-runner-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, "openspec", "changes", "archive"), { recursive: true });
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
  runs = new Run(new RunStore(path.join(root, "runs")));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function workset(changes: string[] = [], stage = "ready"): void {
  fs.writeFileSync(
    path.join(companion, "worksets", "acme-login.yaml"),
    `id: acme-login\ntitle: Login\nrepositories: [acme/web]\nstage: ${stage}\nchanges: [${changes.join(", ")}]\n`,
  );
}

function change(
  name: string,
  options: { repo?: string; dependsOn?: string[]; open?: number; done?: number } = {},
): void {
  const dir = path.join(companion, "openspec", "changes", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "proposal.md"),
    `---\nchange: ${name}\n${options.dependsOn ? `dependsOn: [${options.dependsOn.join(", ")}]\n` : ""}scopes:\n  - repository: ${options.repo ?? "acme/web"}\n    area: web\n---\n# ${name}\n`,
  );
  const tasks = [
    ...Array.from({ length: options.done ?? 0 }, (_, i) => `- [x] ${i + 1}.0 done`),
    ...Array.from({ length: options.open ?? 2 }, (_, i) => `- [ ] ${i + 1}.1 open`),
  ];
  fs.writeFileSync(path.join(dir, "tasks.md"), `# Tasks\n${tasks.join("\n")}\n`);
}

function complete(name: string): void {
  const file = path.join(companion, "openspec", "changes", name, "tasks.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/- \[ \]/g, "- [x]"));
}

function archive(name: string): void {
  fs.renameSync(
    path.join(companion, "openspec", "changes", name),
    path.join(companion, "openspec", "changes", "archive", `2026-10-29-${name}`),
  );
}

/** Each prompt maps to what the agent does in the companion, and what the turn returns. */
function scriptedAgent(
  script: (prompt: string) => TurnOutcome | void | Promise<TurnOutcome | void>,
) {
  const prompts: string[] = [];
  const agent: StageAgent = {
    turn: async ({ prompt, signal }) => {
      prompts.push(prompt);
      if (signal.aborted) throw signal.reason;
      return (await script(prompt)) ?? { kind: "done" };
    },
  };
  return { agent, prompts };
}

function commands(fail: Record<string, string> = {}, branch = "workset/acme-login") {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]): Promise<CommandResult> => {
    calls.push([command, ...args]);
    const key = Object.keys(fail).find((prefix) => [command, ...args].join(" ").startsWith(prefix));
    return key
      ? { status: 1, stdout: "", stderr: fail[key]! }
      : { status: 0, stdout: args.includes("symbolic-ref") ? `${branch}\n` : "{}", stderr: "" };
  };
  return { run, calls };
}

function runner(
  agent: StageAgent,
  run: WorkflowDeps["run"],
  options: { maxRuns?: number; stageMs?: number } = {},
) {
  return new FactoryRunner({
    runs,
    maxRuns: options.maxRuns ?? 2,
    stageMs: options.stageMs ?? 60_000,
    depsFor: () => ({ companionPath: companion, stateDir: "/var/lib/mate-factory", agent, run }),
  });
}

const record = () =>
  parse(fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"));

describe("stage sizes", () => {
  test("apply runs at the build size, every other stage at the agent size", () => {
    expect(memorySizeFor("apply")).toBe("build");
    for (const stage of ["clarify", "explore", "propose", "revise", "publish"] as const) {
      expect(memorySizeFor(stage)).toBe("agent");
    }
    expect(memorySizeFor(undefined)).toBe("build");
  });

  test("every turn of a stage carries the stage", async () => {
    workset();
    const stages: (string | undefined)[] = [];
    const agent: StageAgent = {
      turn: async ({ stage }) => {
        stages.push(stage);
        return { kind: "done" };
      },
    };
    const r = runner(agent, commands().run);
    await r.request("acme-login", "propose");
    await r.idle("acme-login");
    expect(stages.length).toBeGreaterThan(0);
    expect(new Set(stages)).toEqual(new Set(["propose"]));
  });
});

describe("propose", () => {
  test("links the changes it created for the Workset's repository, and starts nothing else", async () => {
    workset();
    const { agent, prompts } = scriptedAgent(() => {
      change("acme-login-a");
      change("acme-login-b");
      change("acme-other", { repo: "acme/api" });
    });
    const r = runner(agent, commands().run);
    await r.request("acme-login", "propose");
    await r.idle("acme-login");
    expect(prompts).toEqual([
      [
        "/mate-propose-change Propose Workset acme-login (Login), one change per slice.",
        "The Workset records no intent.",
        "Use the slices agreed in this conversation when there is one; otherwise slice the intent yourself.",
        "Before you end, report the situation for the person with report_situation.",
      ].join("\n"),
      expect.stringMatching(/^\/mate-show-me acme-login-a\n/),
      expect.stringMatching(/^\/mate-show-me acme-login-b\n/),
    ]);
    expect(record().changes).toEqual(["acme-login-a", "acme-login-b"]);
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
  });

  test("the prompt names the Workset's intent, so a run without a session can propose", () => {
    expect(
      PROMPTS.propose({ id: "acme-login", title: "Login", intent: "Add SSO login.\n" }),
    ).toContain("\nIntent: Add SSO login.\n");
  });

  test("a propose that creates nothing for the repository fails naming it", async () => {
    workset();
    const r = runner(scriptedAgent(() => {}).agent, commands().run);
    await r.request("acme-login", "propose");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "failed",
      reason: "propose created no change for acme/web",
    });
  });
});

const WORKTREE = "/var/lib/mate-factory/worktrees/acme-login";
const nothingToCommit = [
  ["git", "-C", WORKTREE, "add", "--all"],
  ["git", "-C", WORKTREE, "diff", "--cached", "--quiet"],
];

describe("apply", () => {
  test.each(["change/acme-login", "feature/acme-login"])(
    "records and pushes actual existing branch %s",
    async (branch) => {
      change("acme-login-a");
      workset(["acme-login-a"]);
      const { agent } = scriptedAgent((prompt) => {
        if (prompt.startsWith("/mate-apply-change")) complete("acme-login-a");
      });
      const { run, calls } = commands({}, branch);
      const pushed: string[] = [];
      await applyStage(
        {
          companionPath: companion,
          stateDir: "/var/lib/mate-factory",
          agent,
          run,
          log: () => {},
          signal: new AbortController().signal,
          onPushed: (value) => {
            pushed.push(value);
          },
        },
        "acme-login",
      );
      expect(calls).toContainEqual([
        "mate",
        "artifact",
        "link",
        "acme-login-a",
        "--repository",
        "acme/web",
        "--branch",
        branch,
        "--json",
      ]);
      expect(calls).toContainEqual([
        "git",
        "-C",
        "/var/lib/mate-factory/repos/acme__web",
        "push",
        "origin",
        branch,
      ]);
      expect(pushed).toEqual([branch]);
    },
  );

  test("matching recorded delivery is not rewritten", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    const dir = path.join(companion, "openspec/changes/acme-login-a");
    await writeDeliveryRecord(
      dir,
      upsertDelivery(unlinkedRecord("acme-login-a"), "acme/web", {
        branch: "change/acme-login",
        direct: true,
      }),
    );
    const before = fs.readFileSync(path.join(dir, "delivery.yaml"), "utf8");
    const { agent } = scriptedAgent((prompt) => {
      if (prompt.startsWith("/mate-apply-change")) complete("acme-login-a");
    });
    const { run, calls } = commands({}, "change/acme-login");
    await applyStage(
      {
        companionPath: companion,
        stateDir: "/var/lib/mate-factory",
        agent,
        run,
        log: () => {},
        signal: new AbortController().signal,
      },
      "acme-login",
    );
    expect(fs.readFileSync(path.join(dir, "delivery.yaml"), "utf8")).toBe(before);
    expect(calls.some((call) => call[0] === "mate")).toBe(false);
  });

  test("conflicting recorded delivery stops before a continuation turn or writes", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    await writeDeliveryRecord(
      path.join(companion, "openspec/changes/acme-login-a"),
      upsertDelivery(unlinkedRecord("acme-login-a"), "acme/web", { branch: "change/acme-login" }),
    );
    const { agent, prompts } = scriptedAgent(() => {});
    const { run, calls } = commands();
    await expect(
      applyStage(
        {
          companionPath: companion,
          stateDir: "/var/lib/mate-factory",
          agent,
          run,
          log: () => {},
          signal: new AbortController().signal,
        },
        "acme-login",
        "continue",
      ),
    ).rejects.toThrow(/confirm an explicit relink/);
    expect(prompts).toEqual([]);
    expect(calls.every((call) => call.includes("symbolic-ref"))).toBe(true);
  });

  test("detached HEAD stops before turns or delivery edits", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    const { agent, prompts } = scriptedAgent(() => {});
    const { run, calls } = commands({ [`git -C ${WORKTREE} symbolic-ref`]: "detached" });
    await expect(
      applyStage(
        {
          companionPath: companion,
          stateDir: "/var/lib/mate-factory",
          agent,
          run,
          log: () => {},
          signal: new AbortController().signal,
        },
        "acme-login",
      ),
    ).rejects.toThrow(/detached or unreadable HEAD/);
    expect(prompts).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("a branch switch during apply stops before push", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    let branch = "change/acme-login";
    const { agent } = scriptedAgent((prompt) => {
      if (prompt.startsWith("/mate-apply-change")) {
        complete("acme-login-a");
        branch = "feature/acme-other";
      }
    });
    const fake = commands();
    const run: WorkflowDeps["run"] = async (command, args) => {
      const result = await fake.run(command, args);
      return args.includes("symbolic-ref") ? { ...result, stdout: `${branch}\n` } : result;
    };
    await expect(
      applyStage(
        {
          companionPath: companion,
          stateDir: "/var/lib/mate-factory",
          agent,
          run,
          log: () => {},
          signal: new AbortController().signal,
        },
        "acme-login",
      ),
    ).rejects.toThrow(/changed branches during apply/);
    expect(fake.calls.some((call) => call.includes("push"))).toBe(false);
  });

  test("applies in dependency order on workset/<workset>, pushes from the appliance, then archives", async () => {
    change("acme-login-b", { dependsOn: ["acme-login-a"] });
    change("acme-login-a");
    workset(["acme-login-b", "acme-login-a"]);
    const { agent, prompts } = scriptedAgent((prompt) => {
      const applied = /^\/mate-apply-change (.+)$/m.exec(prompt)?.[1];
      if (applied) complete(applied);
      const archived = /^\/mate-archive-change (.+)$/.exec(prompt)?.[1];
      if (archived) archive(archived);
    });
    const { run, calls } = commands();
    const r = runner(agent, run);
    await r.request("acme-login", "apply");
    await r.idle("acme-login");
    expect(prompts).toEqual([
      PROMPTS.apply("acme-login-a"),
      PROMPTS.apply("acme-login-b"),
      "/mate-archive-change acme-login-a",
      "/mate-archive-change acme-login-b",
    ]);
    expect(calls.filter((call) => !call.includes("symbolic-ref"))).toEqual([
      [
        "mate",
        "artifact",
        "link",
        "acme-login-a",
        "--repository",
        "acme/web",
        "--branch",
        "workset/acme-login",
        "--json",
      ],
      ...nothingToCommit,
      [
        "mate",
        "artifact",
        "link",
        "acme-login-b",
        "--repository",
        "acme/web",
        "--branch",
        "workset/acme-login",
        "--json",
      ],
      ...nothingToCommit,
      ...nothingToCommit,
      [
        "git",
        "-C",
        "/var/lib/mate-factory/repos/acme__web",
        "push",
        "origin",
        "workset/acme-login",
      ],
    ]);
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
  });

  test("the agent's work is committed before the push, with a Workset trailer", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    const { agent } = scriptedAgent((prompt) => {
      if (prompt.startsWith("/mate-apply-change")) complete("acme-login-a");
    });
    // `diff --cached --quiet` exits 1: work is staged.
    const { run, calls } = commands({ [`git -C ${WORKTREE} diff`]: "" });
    const r = runner(agent, run);
    await r.request("acme-login", "apply");
    await r.idle("acme-login");
    const git = calls.filter((call) => call[0] === "git" && !call.includes("symbolic-ref"));
    expect(git.slice(0, 3)).toEqual([
      ["git", "-C", WORKTREE, "add", "--all"],
      ["git", "-C", WORKTREE, "diff", "--cached", "--quiet"],
      [
        "git",
        "-C",
        WORKTREE,
        "commit",
        "--quiet",
        "-m",
        "Apply acme-login-a\n\nWorkset: acme-login",
      ],
    ]);
    expect(git.at(-1)).toEqual([
      "git",
      "-C",
      "/var/lib/mate-factory/repos/acme__web",
      "push",
      "origin",
      "workset/acme-login",
    ]);
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
  });

  test("the commit message names every change and the Workset as a trailer", () => {
    expect(applyMessage(["acme-a", "acme-b"], "acme-login")).toBe(
      "Apply acme-a, acme-b\n\nWorkset: acme-login",
    );
  });

  test("open tasks stop the run before push and archive, naming the change", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    const { agent, prompts } = scriptedAgent(() => {});
    const { run, calls } = commands();
    const r = runner(agent, run);
    await r.request("acme-login", "apply");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "failed",
      reason: "tasks are still open: acme-login-a (2 open)",
    });
    expect(
      calls.filter((call) => call[0] === "git").every((call) => call.includes("symbolic-ref")),
    ).toBe(true);
    expect(prompts.some((prompt) => prompt.startsWith("/mate-archive-change"))).toBe(false);
  });

  test("a rejected push stops the run before archive with the remote's reason", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    const { agent, prompts } = scriptedAgent((prompt) => {
      if (prompt.startsWith("/mate-apply-change")) complete("acme-login-a");
    });
    const r = runner(
      agent,
      commands({
        "git -C /var/lib/mate-factory/repos": "! [rejected] workset/acme-login (non-fast-forward)",
      }).run,
    );
    await r.request("acme-login", "apply");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "failed",
      reason:
        "pushing workset/acme-login failed: ! [rejected] workset/acme-login (non-fast-forward)",
    });
    expect(prompts.some((prompt) => prompt.startsWith("/mate-archive-change"))).toBe(false);
  });
});

describe("questions", () => {
  test("a question waits on the card, and the answer starts the next turn in the same run", async () => {
    workset();
    let asked = false;
    const { agent, prompts } = scriptedAgent((prompt) => {
      if (!asked) {
        asked = true;
        return { kind: "question", questions: [{ question: "Which login provider?" }] };
      }
      // As in a real run, the turn that receives the answer creates the change.
      if (prompt === "Use the company IdP.") change("acme-login-a");
    });
    const r = runner(agent, commands().run);
    await r.request("acme-login", "propose");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "waiting",
      questions: [{ question: "Which login provider?" }],
    });

    // A restarted Studio reads the same question and accepts the answer.
    const restarted = runner(agent, commands().run);
    await restarted.answer("acme-login", "Use the company IdP.");
    await restarted.idle("acme-login");
    expect(prompts.slice(1)).toEqual([
      "Use the company IdP.",
      expect.stringMatching(/^\/mate-show-me acme-login-a\n/),
    ]);
    expect(record().changes).toEqual(["acme-login-a"]);
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
  });
});

describe("publish", () => {
  test("publishes each linked archived change through the publish command", async () => {
    change("acme-login-a");
    archive("acme-login-a");
    workset(["acme-login-a"]);
    const { run, calls } = commands();
    const r = runner(scriptedAgent(() => {}).agent, run);
    await r.request("acme-login", "publish");
    await r.idle("acme-login");
    expect(calls).toEqual([["mate", "artifact", "publish", "acme-login-a", "--json"]]);
  });
});

describe("limits", () => {
  test("runs at most the cap at once and queues the rest in order", async () => {
    for (const id of ["acme-a", "acme-b", "acme-c"]) {
      fs.writeFileSync(
        path.join(companion, "worksets", `${id}.yaml`),
        `id: ${id}\nrepositories: [acme/web]\nstage: ready\n`,
      );
    }
    const release: Array<() => void> = [];
    const agent: StageAgent = {
      turn: () =>
        new Promise<TurnOutcome>((resolve) => release.push(() => resolve({ kind: "done" }))),
    };
    const r = runner(agent, commands().run, { maxRuns: 2 });
    for (const id of ["acme-a", "acme-b", "acme-c"]) await r.request(id, "propose");
    await Bun.sleep(20);
    expect(release).toHaveLength(2);
    expect((await runs.facts("acme-c")).execution.state).toBe("queued");
    release[0]!();
    await Bun.sleep(20);
    expect(release).toHaveLength(3);
    for (const next of release.slice(1)) next();
    for (const id of ["acme-a", "acme-b", "acme-c"]) await r.idle(id);
  });

  test("a stage past its budget fails naming the budget", async () => {
    workset();
    const agent: StageAgent = {
      turn: ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    };
    const r = runner(agent, commands().run, { stageMs: 30 });
    await r.request("acme-login", "propose");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "failed",
      reason: "the stage exceeded its budget of 0 minutes",
    });
  });

  test("cancelling stops the agent and fails the run as cancelled", async () => {
    workset();
    const agent: StageAgent = {
      turn: ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    };
    const r = runner(agent, commands().run);
    await r.request("acme-login", "propose");
    await Bun.sleep(10);
    await r.cancel("acme-login");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "failed",
      reason: "cancelled",
    });
  });

  test("a second request for a busy Workset is refused", async () => {
    workset();
    const agent: StageAgent = {
      turn: ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    };
    const r = runner(agent, commands().run);
    await r.request("acme-login", "propose");
    await expect(r.request("acme-login", "apply")).rejects.toThrow(/already has a run/);
    await Bun.sleep(10);
    await r.cancel("acme-login");
    await r.idle("acme-login");
  });
});

describe("dependency order", () => {
  test("refuses changes that depend on each other", async () => {
    change("acme-a", { dependsOn: ["acme-b"] });
    change("acme-b", { dependsOn: ["acme-a"] });
    await expect(inDependencyOrder(companion, ["acme-a", "acme-b"])).rejects.toThrow(
      /depend on each other/,
    );
  });
});

describe("clarify and explore", () => {
  test("a clear intent skips to explore after one clarify turn", async () => {
    workset([], "clarify-intent");
    const { agent, prompts } = scriptedAgent(() => {});
    const r = runner(agent, commands().run);
    await r.request("acme-login", "clarify");
    await r.idle("acme-login");
    expect(prompts[0]).toStartWith("/mate-clarify-intent Login");
    expect(prompts[0]).not.toContain("factory-run");
    expect(record().stage).toBe("explore");
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
  });

  test("an unclear intent waits with the question and keeps the stage", async () => {
    workset([], "clarify-intent");
    const { agent } = scriptedAgent(() => ({
      kind: "question",
      questions: [{ question: "How is success measured?" }],
    }));
    const r = runner(agent, commands().run);
    await r.request("acme-login", "clarify");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "waiting",
      stage: "clarify",
      questions: [{ question: "How is success measured?" }],
    });
    expect(record().stage).toBe("clarify-intent");
  });

  test("an answer continues clarify with the person's text", async () => {
    workset([], "clarify-intent");
    await runs.wait("acme-login", "clarify", [{ question: "?" }]);
    const { agent, prompts } = scriptedAgent(() => {});
    const r = runner(agent, commands().run);
    await r.answer("acme-login", "Fewer missed reviews.");
    await r.idle("acme-login");
    expect(prompts).toEqual(["Fewer missed reviews."]);
    expect(record().stage).toBe("explore");
  });

  test("explore ends at ready and creates no change", async () => {
    workset([], "explore");
    const { agent, prompts } = scriptedAgent(() => {});
    const r = runner(agent, commands().run);
    await r.request("acme-login", "explore");
    await r.idle("acme-login");
    expect(prompts[0]).toStartWith("/mate-explore-change Explore Workset acme-login (Login)");
    expect(prompts[0]).toContain("Write no files.");
    expect(record().stage).toBe("ready");
    expect(fs.readdirSync(path.join(companion, "openspec", "changes"))).toEqual(["archive"]);
  });
});

describe("review reports", () => {
  function reportingAgent(write: (file: string) => void = () => {}) {
    const turns: { prompt: string; env?: Record<string, string> }[] = [];
    const agent: StageAgent = {
      turn: async ({ prompt, env }) => {
        turns.push({ prompt, ...(env ? { env } : {}) });
        if (prompt.startsWith("/mate-propose-change Propose")) change("acme-login-a");
        if (env?.MATE_REPORT_OUTPUT) write(env.MATE_REPORT_OUTPUT);
        return { kind: "done" };
      },
    };
    return { agent, turns };
  }

  function reportRunner(agent: StageAgent, stored: [string, string][]) {
    return new FactoryRunner({
      runs,
      maxRuns: 1,
      stageMs: 60_000,
      depsFor: () => ({
        companionPath: companion,
        stateDir: root,
        agent,
        run: commands().run,
        storeReport: async (change, file) => {
          stored.push([change, fs.readFileSync(file, "utf8")]);
        },
      }),
    });
  }

  test("propose ends with a show-me turn per change whose report goes outside the worktree", async () => {
    workset();
    const { agent, turns } = reportingAgent((file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "<html>review</html>");
    });
    const stored: [string, string][] = [];
    const r = reportRunner(agent, stored);
    await r.request("acme-login", "propose");
    await r.idle("acme-login");
    const review = turns.find((entry) => entry.prompt.startsWith("/mate-show-me acme-login-a"));
    expect(review?.env?.MATE_REPORT_OUTPUT).toBe(
      path.join(
        root,
        "repos",
        "acme__web",
        ".git",
        "mate-factory",
        "reports",
        "acme-login",
        "acme-login-a.html",
      ),
    );
    expect(review?.env?.MATE_REPORT_OUTPUT).not.toContain("worktrees");
    expect(review?.prompt).toContain(`MATE_REPORT_OUTPUT=${review?.env?.MATE_REPORT_OUTPUT}`);
    expect(stored).toEqual([["acme-login-a", "<html>review</html>"]]);
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
  });

  test("a missing report is logged and propose still ends", async () => {
    workset();
    const stored: [string, string][] = [];
    const r = reportRunner(reportingAgent().agent, stored);
    await r.request("acme-login", "propose");
    await r.idle("acme-login");
    expect(stored).toEqual([]);
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
    expect(await runs.readLog("acme-login")).toContain(
      "no review report was produced for acme-login-a",
    );
  });

  test("feedback at review revises the changes, then rebuilds their reports", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    const { agent, turns } = reportingAgent();
    const r = reportRunner(agent, []);
    await r.feedback("acme-login", "Split the form from the provider settings.");
    await r.idle("acme-login");
    expect(turns.map((entry) => entry.prompt)).toEqual([
      [
        "/mate-propose-change Revise acme-login-a with this feedback:",
        "Split the form from the provider settings.",
        "Before you end, report the situation for the person with report_situation.",
      ].join("\n"),
      expect.stringMatching(/^\/mate-show-me acme-login-a\n/),
    ]);
  });

  test("feedback while building revises, then continues apply on the same branch", async () => {
    change("acme-login-a", { done: 1, open: 1 });
    workset(["acme-login-a"]);
    const { agent, prompts } = scriptedAgent((prompt) => {
      if (prompt.startsWith("/mate-apply-change")) complete("acme-login-a");
      const archived = /^\/mate-archive-change (.+)$/.exec(prompt)?.[1];
      if (archived) archive(archived);
    });
    const { run, calls } = commands();
    const r = runner(agent, run);
    await r.feedback("acme-login", "Keep the old route as a redirect.");
    await r.idle("acme-login");
    expect(prompts[0]).toStartWith("/mate-propose-change Revise acme-login-a with this feedback:");
    expect(prompts).toContain(PROMPTS.apply("acme-login-a"));
    expect(calls).toContainEqual(expect.arrayContaining(["push", "origin", "workset/acme-login"]));
    expect((await runs.facts("acme-login")).execution.state).toBe("idle");
  });

  test("an answer to a revise question continues that turn, not a new revise", async () => {
    change("acme-login-a");
    workset(["acme-login-a"]);
    const { agent, prompts } = scriptedAgent((prompt) =>
      prompt.startsWith("/mate-propose-change Revise")
        ? { kind: "question", questions: [{ question: "Keep the old route?" }] }
        : undefined,
    );
    const r = runner(agent, commands().run);
    await r.feedback("acme-login", "Keep the old route as a redirect.");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution.state).toBe("waiting");
    await r.answer("acme-login", "yes");
    await r.idle("acme-login");
    expect(prompts[1]).toBe("yes");
  });

  test("feedback after archive proposes a follow-up change for the same Outcome", async () => {
    workset(["acme-login-a"]);
    const { agent, prompts } = scriptedAgent((prompt) => {
      if (prompt.includes("follow-up change")) change("acme-login-b");
    });
    const r = new FactoryRunner({
      runs,
      maxRuns: 1,
      stageMs: 60_000,
      depsFor: () => ({ companionPath: companion, stateDir: root, agent, run: commands().run }),
      recordFor: async (id) => ({ id, title: "Login" }),
    });
    await r.feedback("acme-login", "Make the first step even simpler.", true);
    await r.idle("acme-login");
    expect(prompts[0]).toStartWith(
      "/mate-propose-change Propose one follow-up change for Workset acme-login (Login)",
    );
    expect(prompts[0]).toContain("Make the first step even simpler.");
    expect(record().changes).toEqual(["acme-login-a", "acme-login-b"]);
  });

  test("empty feedback is refused", async () => {
    workset(["acme-login-a"]);
    const r = reportRunner(reportingAgent().agent, []);
    await expect(r.feedback("acme-login", "  ")).rejects.toThrow("cannot be empty");
  });
});

describe("grouped questions", () => {
  function askingAgent() {
    const agent: StageAgent = {
      turn: async () => ({
        kind: "question",
        questions: [
          { question: "Which provider?", options: ["SAML", "OIDC"], recommended: "OIDC" },
          { question: "Keep the old login page?" },
        ],
      }),
    };
    return { agent };
  }

  test("grouped questions keep their order, options and recommendation", async () => {
    workset([], "clarify-intent");
    const { agent } = askingAgent();
    const r = runner(agent, commands().run);
    await r.request("acme-login", "clarify");
    await r.idle("acme-login");
    expect((await runs.facts("acme-login")).execution).toMatchObject({
      state: "waiting",
      questions: [
        { question: "Which provider?", options: ["SAML", "OIDC"], recommended: "OIDC" },
        { question: "Keep the old login page?" },
      ],
    });
  });

  test("several answers go back as each question with its answer", async () => {
    workset([], "clarify-intent");
    const { agent } = askingAgent();
    const r = runner(agent, commands().run);
    await r.request("acme-login", "clarify");
    await r.idle("acme-login");
    const prompts: string[] = [];
    const answered = runner(
      {
        turn: async ({ prompt }) => {
          prompts.push(prompt);
          return { kind: "done" };
        },
      },
      commands().run,
    );
    await expect(answered.answer("acme-login", ["", " "])).rejects.toThrow("cannot be empty");
    await answered.answer("acme-login", ["OIDC", ""]);
    await answered.idle("acme-login");
    expect(prompts[0]).toBe(
      [
        "1. Which provider?",
        "Answer: OIDC",
        "",
        "2. Keep the old login page?",
        "Answer: no answer; take your recommendation",
      ].join("\n"),
    );
  });
});
