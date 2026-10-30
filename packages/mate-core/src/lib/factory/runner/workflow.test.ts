import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import type { CommandResult } from "../command";
import { FactoryRunner } from "./scheduler";
import { RunStore } from "./state";
import {
  applyMessage,
  inDependencyOrder,
  PROMPTS,
  type StageAgent,
  type TurnOutcome,
  type WorkflowDeps,
} from "./workflow";

let root: string;
let companion: string;
let store: RunStore;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-runner-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, "openspec", "changes", "archive"), { recursive: true });
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
  store = new RunStore(path.join(root, "runs"));
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

function commands(fail: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]): Promise<CommandResult> => {
    calls.push([command, ...args]);
    const key = Object.keys(fail).find((prefix) => [command, ...args].join(" ").startsWith(prefix));
    return key
      ? { status: 1, stdout: "", stderr: fail[key]! }
      : { status: 0, stdout: "{}", stderr: "" };
  };
  return { run, calls };
}

function runner(
  agent: StageAgent,
  run: WorkflowDeps["run"],
  options: { maxRuns?: number; stageMs?: number } = {},
) {
  return new FactoryRunner({
    store,
    maxRuns: options.maxRuns ?? 2,
    stageMs: options.stageMs ?? 60_000,
    depsFor: () => ({ companionPath: companion, stateDir: "/var/lib/mate-factory", agent, run }),
  });
}

const record = () =>
  parse(fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"));

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
        "Ask with ask_human only what a person must decide.",
      ].join("\n"),
    ]);
    expect(record().changes).toEqual(["acme-login-a", "acme-login-b"]);
    expect((await store.read("acme-login")).state).toBe("idle");
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
    expect(await store.read("acme-login")).toMatchObject({
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
  test("applies in dependency order on change/<workset>, pushes from the appliance, then archives", async () => {
    change("acme-login-b", { dependsOn: ["acme-login-a"] });
    change("acme-login-a");
    workset(["acme-login-b", "acme-login-a"]);
    const { agent, prompts } = scriptedAgent((prompt) => {
      const applied = /^\/mate-apply-change (.+)$/.exec(prompt)?.[1];
      if (applied) complete(applied);
      const archived = /^\/mate-archive-change (.+)$/.exec(prompt)?.[1];
      if (archived) archive(archived);
    });
    const { run, calls } = commands();
    const r = runner(agent, run);
    await r.request("acme-login", "apply");
    await r.idle("acme-login");
    expect(prompts).toEqual([
      "/mate-apply-change acme-login-a",
      "/mate-apply-change acme-login-b",
      "/mate-archive-change acme-login-a",
      "/mate-archive-change acme-login-b",
    ]);
    expect(calls).toEqual([
      [
        "mate",
        "artifact",
        "link",
        "acme-login-a",
        "--repository",
        "acme/web",
        "--branch",
        "change/acme-login",
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
        "change/acme-login",
        "--json",
      ],
      ...nothingToCommit,
      ...nothingToCommit,
      ["git", "-C", "/var/lib/mate-factory/repos/acme__web", "push", "origin", "change/acme-login"],
    ]);
    expect((await store.read("acme-login")).state).toBe("idle");
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
    const git = calls.filter((call) => call[0] === "git");
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
      "change/acme-login",
    ]);
    expect((await store.read("acme-login")).state).toBe("idle");
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
    expect(await store.read("acme-login")).toMatchObject({
      state: "failed",
      reason: "tasks are still open: acme-login-a (2 open)",
    });
    expect(calls.some((call) => call[0] === "git")).toBe(false);
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
        "git -C /var/lib/mate-factory/repos": "! [rejected] change/acme-login (non-fast-forward)",
      }).run,
    );
    await r.request("acme-login", "apply");
    await r.idle("acme-login");
    expect(await store.read("acme-login")).toMatchObject({
      state: "failed",
      reason: "pushing change/acme-login failed: ! [rejected] change/acme-login (non-fast-forward)",
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
        return { kind: "question", question: "Which login provider?" };
      }
      // As in a real run, the turn that receives the answer creates the change.
      if (prompt === "Use the company IdP.") change("acme-login-a");
    });
    const r = runner(agent, commands().run);
    await r.request("acme-login", "propose");
    await r.idle("acme-login");
    expect(await store.read("acme-login")).toMatchObject({
      state: "waiting",
      question: "Which login provider?",
    });

    // A restarted Studio reads the same question and accepts the answer.
    const restarted = runner(agent, commands().run);
    await restarted.answer("acme-login", "Use the company IdP.");
    await restarted.idle("acme-login");
    expect(prompts.slice(1)).toEqual(["Use the company IdP."]);
    expect(record().changes).toEqual(["acme-login-a"]);
    expect((await store.read("acme-login")).state).toBe("idle");
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
    expect((await store.read("acme-c")).state).toBe("queued");
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
    expect(await store.read("acme-login")).toMatchObject({
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
    expect(await store.read("acme-login")).toMatchObject({ state: "failed", reason: "cancelled" });
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
