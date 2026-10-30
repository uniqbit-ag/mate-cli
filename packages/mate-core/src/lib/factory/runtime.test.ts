import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandOptions, CommandResult, CommandRunner } from "./command";
import { WorksetRuntime } from "./runtime";

/**
 * A fake `docker` and `git`: containers live in a map, clones and worktrees
 * are directories in a temporary state volume. Every call is recorded with
 * the identity and environment it ran with.
 */
interface Call {
  command: string;
  args: string[];
  options: CommandOptions;
}

interface Fake {
  run: CommandRunner;
  calls: Call[];
  containers: Map<string, { running: boolean; labels: Record<string, string> }>;
  remoteBranches: Set<string>;
  dirty: Set<string>;
  unpushed: Map<string, number>;
  sysbox: boolean;
}

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });

function fake(): Fake {
  const state: Fake = {
    calls: [],
    containers: new Map(),
    remoteBranches: new Set(),
    dirty: new Set(),
    unpushed: new Map(),
    sysbox: true,
    run: async () => ok(),
  };
  state.run = async (command, args, options = {}) => {
    state.calls.push({ command, args, options });
    if (command === "docker") return docker(state, args);
    return git(state, args.slice(2));
  };
  return state;
}

function docker(state: Fake, args: string[]): CommandResult {
  const [verb] = args;
  const name = args.at(-1)!;
  switch (verb) {
    case "info":
      return ok(state.sysbox ? '{"runc":{},"sysbox-runc":{}}' : '{"runc":{}}');
    case "container": {
      const container = state.containers.get(name);
      if (!container) return failed("No such container");
      if (args.join(" ").includes("IPAddress")) return ok("172.18.0.5 ");
      return ok(String(container.running));
    }
    case "create": {
      const labels: Record<string, string> = {};
      args.forEach((arg, index) => {
        if (arg === "--label") {
          const [key, value] = args[index + 1]!.split("=");
          labels[key!] = value!;
        }
      });
      state.containers.set(args[args.indexOf("--name") + 1]!, { running: false, labels });
      return ok();
    }
    case "start":
      state.containers.get(name)!.running = true;
      return ok();
    case "stop":
      state.containers.get(name)!.running = false;
      return ok();
    case "rm":
      state.containers.delete(name);
      return ok();
    case "exec":
      return ok(
        `ran ${args.slice(args.findIndex((arg) => arg.startsWith("workset-")) + 1).join(" ")}`,
      );
    case "ps":
      return ok(
        [...state.containers.values()]
          .map(
            (container) =>
              `${container.labels["dev.mate.workset"]}\t${container.labels["dev.mate.repository"]}\t${container.running ? "running" : "exited"}`,
          )
          .join("\n"),
      );
    default:
      return failed(`unexpected docker ${verb}`);
  }
}

function git(state: Fake, args: string[]): CommandResult {
  const dir = args[0] === "-C" ? args[1]! : "";
  const rest = args[0] === "-C" ? args.slice(2) : args;
  switch (rest[0]) {
    case "clone":
      fs.mkdirSync(path.join(rest.at(-1)!, ".git", "worktrees"), { recursive: true });
      return ok();
    case "fetch":
      return ok();
    case "rev-parse": {
      const ref = rest.at(-1)!;
      return ref.startsWith("refs/remotes/origin/") &&
        state.remoteBranches.has(ref.replace("refs/remotes/origin/", ""))
        ? ok("abc")
        : failed("");
    }
    case "worktree": {
      if (rest[1] === "remove") {
        fs.rmSync(rest.at(-1)!, { recursive: true, force: true });
        return ok();
      }
      const worktree = rest.find((arg) => arg.includes("/worktrees/"))!;
      const id = path.basename(worktree);
      fs.mkdirSync(worktree, { recursive: true });
      fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${dir}/.git/worktrees/${id}\n`);
      return ok();
    }
    case "status":
      return ok(state.dirty.has(path.basename(dir)) ? " M src/app.ts\n" : "");
    case "rev-list":
      return ok(String(state.unpushed.get(path.basename(dir)) ?? 0));
    default:
      return failed(`unexpected git ${rest[0]}`);
  }
}

let root: string;
let companion: string;
let state: Fake;
let runtime: WorksetRuntime;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-factory-")));
  companion = path.join(root, "companions", "acme");
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(companion, ".mate", "config", "framework.yaml"), "type: companion\n");
  fs.writeFileSync(path.join(root, "docker.sock"), "");
  state = fake();
  runtime = new WorksetRuntime({
    dockerHost: `unix://${root}/docker.sock`,
    stateDir: path.join(root, "state"),
    image: "mate-workset:1.0.0-acme",
    user: "mate",
    companionsDir: path.join(root, "companions"),
    run: state.run,
  });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const spawnAcme = (id = "acme-login") =>
  runtime.spawn({
    id,
    repository: "acme/app",
    remoteUrl: "https://git.acme.test/acme/app.git",
    companion,
  });

const gitCalls = () =>
  state.calls.filter((call) => call.command === "git").map((call) => call.args.slice(2));
const dockerCall = (verb: string) =>
  state.calls.find((call) => call.command === "docker" && call.args[0] === verb);

describe("availability", () => {
  test("outside factory mode every operation fails and creates nothing", async () => {
    fs.rmSync(path.join(root, "docker.sock"));
    await expect(spawnAcme()).rejects.toThrow(/factory mode/);
    await expect(runtime.list()).rejects.toThrow(/factory mode/);
    expect(gitCalls()).toEqual([]);
    expect(fs.existsSync(path.join(root, "state"))).toBe(false);
  });

  test("an inner daemon without Sysbox is named", async () => {
    state.sysbox = false;
    await expect(spawnAcme()).rejects.toThrow(/sysbox-runc/);
    expect(gitCalls()).toEqual([]);
  });
});

describe("spawn", () => {
  test("clones once and creates change/<workset> from the remote default branch", async () => {
    const info = await spawnAcme();
    expect(info).toEqual({
      id: "acme-login",
      repository: "acme/app",
      branch: "change/acme-login",
      state: "running",
    });
    const repo = path.join(root, "state", "repos", "acme__app");
    expect(gitCalls()).toContainEqual(["clone", "--", "https://git.acme.test/acme/app.git", repo]);
    expect(gitCalls()).toContainEqual([
      "-C",
      repo,
      "worktree",
      "add",
      "--no-track",
      "-b",
      "change/acme-login",
      path.join(root, "state", "worktrees", "acme-login"),
      "origin/HEAD",
    ]);

    await spawnAcme("acme-signup");
    expect(gitCalls().filter((args) => args[0] === "clone")).toHaveLength(1);
    expect(gitCalls()).toContainEqual(["-C", repo, "fetch", "--prune", "origin"]);
  });

  test("an existing remote Delivery Branch is checked out", async () => {
    state.remoteBranches.add("change/acme-login");
    await spawnAcme();
    expect(gitCalls().find((args) => args[2] === "worktree")).toContain("origin/change/acme-login");
  });

  test("a second spawn reuses the worktree unchanged", async () => {
    await spawnAcme();
    const worktree = path.join(root, "state", "worktrees", "acme-login");
    fs.writeFileSync(path.join(worktree, "draft.md"), "uncommitted");
    state.calls.length = 0;
    await spawnAcme();
    expect(gitCalls().some((args) => args.includes("worktree"))).toBe(false);
    expect(fs.readFileSync(path.join(worktree, "draft.md"), "utf8")).toBe("uncommitted");
  });

  test("git runs as the unprivileged user, docker as the broker", async () => {
    await spawnAcme();
    for (const call of state.calls) {
      expect(call.options.asUser).toBe(call.command === "git" ? "mate" : undefined);
    }
  });

  test("the container is unprivileged Sysbox with labels and exactly three identical-path mounts", async () => {
    await spawnAcme();
    const create = dockerCall("create")!.args;
    const worktree = path.join(root, "state", "worktrees", "acme-login");
    const gitDir = path.join(root, "state", "repos", "acme__app", ".git");
    expect(create).toContain("sysbox-runc");
    expect(create).not.toContain("--privileged");
    expect(create).toContain("dev.mate.workset=acme-login");
    expect(create).toContain("dev.mate.repository=acme/app");
    const mounts = create.filter((_, index) => create[index - 1] === "--volume");
    expect(mounts).toEqual([
      `${worktree}:${worktree}`,
      `${gitDir}:${gitDir}`,
      `${companion}:${companion}`,
    ]);
    expect(create.join(" ")).not.toContain("docker.sock");
    expect(create.at(-1)).toBe("mate-workset:1.0.0-acme");
  });

  test.each(["Acme", "acme/login", "acme login", "../acme", "acme--x", "-acme"])(
    "refuses identifier %j before creating anything",
    async (id) => {
      await expect(spawnAcme(id)).rejects.toThrow(/kebab-case/);
      expect(state.calls).toEqual([]);
    },
  );

  test("refuses a companion outside the companions directory", async () => {
    const outside = path.join(root, "elsewhere");
    fs.mkdirSync(path.join(outside, ".mate", "config"), { recursive: true });
    fs.writeFileSync(path.join(outside, ".mate", "config", "framework.yaml"), "");
    await expect(
      runtime.spawn({
        id: "acme-login",
        repository: "acme/app",
        remoteUrl: "x",
        companion: outside,
      }),
    ).rejects.toThrow(/not a companion under/);
    expect(state.calls).toEqual([]);
  });

  test("refuses a remote URL that would be read as an option", async () => {
    await expect(
      runtime.spawn({
        id: "acme-login",
        repository: "acme/app",
        remoteUrl: "--upload-pack=x",
        companion,
      }),
    ).rejects.toThrow(/remote URL/);
  });
});

describe("pause, resume and exec", () => {
  test("pause stops and resume starts the same container", async () => {
    await spawnAcme();
    await runtime.pause("acme-login");
    expect(state.containers.get("workset-acme-login")!.running).toBe(false);
    await runtime.resume("acme-login");
    expect(state.containers.get("workset-acme-login")!.running).toBe(true);
    expect(state.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
  });

  test("exec runs as mate in the worktree and returns the command's result", async () => {
    await spawnAcme();
    const result = await runtime.exec({ id: "acme-login", command: ["git", "status"], cwd: "src" });
    expect(result).toEqual({ status: 0, stdout: "ran git status", stderr: "" });
    const exec = dockerCall("exec")!.args;
    expect(exec.slice(0, 5)).toEqual([
      "exec",
      "--user",
      "mate",
      "--workdir",
      path.join(root, "state", "worktrees", "acme-login", "src"),
    ]);
  });

  test("a per-command value reaches the docker client's environment, never its arguments", async () => {
    await spawnAcme();
    await runtime.exec({
      id: "acme-login",
      command: ["claude"],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "acme-token" },
    });
    const exec = dockerCall("exec")!;
    expect(exec.args).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(exec.args.join(" ")).not.toContain("acme-token");
    expect(exec.options.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe("acme-token");
    expect(JSON.stringify(dockerCall("create"))).not.toContain("acme-token");

    state.calls.length = 0;
    await runtime.exec({ id: "acme-login", command: ["env"] });
    expect(dockerCall("exec")!.options.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("exec in a paused Workset fails without starting it", async () => {
    await spawnAcme();
    await runtime.pause("acme-login");
    await expect(runtime.exec({ id: "acme-login", command: ["true"] })).rejects.toThrow(/paused/);
    expect(state.containers.get("workset-acme-login")!.running).toBe(false);
  });

  test("exec refuses a working directory outside the worktree", async () => {
    await spawnAcme();
    await expect(
      runtime.exec({ id: "acme-login", command: ["true"], cwd: "../acme-other" }),
    ).rejects.toThrow(/outside the worktree/);
  });
});

describe("list", () => {
  test("reports running, paused and missing Worksets with repository and branch", async () => {
    await spawnAcme("acme-a");
    await spawnAcme("acme-b");
    await runtime.pause("acme-b");
    state.containers.delete("workset-acme-c");
    await spawnAcme("acme-c");
    state.containers.delete("workset-acme-c");

    expect(await runtime.list()).toEqual([
      { id: "acme-a", repository: "acme/app", branch: "change/acme-a", state: "running" },
      { id: "acme-b", repository: "acme/app", branch: "change/acme-b", state: "paused" },
      { id: "acme-c", repository: "acme/app", branch: "change/acme-c", state: "missing" },
    ]);
  });

  test("after an appliance restart every Workset reads as paused", async () => {
    await spawnAcme();
    for (const container of state.containers.values()) container.running = false;
    expect((await runtime.list())[0]!.state).toBe("paused");
  });
});

describe("delete", () => {
  test("refuses uncommitted changes and unpushed commits, naming them", async () => {
    await spawnAcme();
    state.dirty.add("acme-login");
    state.unpushed.set("acme-login", 2);
    await expect(runtime.delete("acme-login")).rejects.toThrow(
      /uncommitted changes and 2 unpushed commit/,
    );
    expect(state.containers.has("workset-acme-login")).toBe(true);
  });

  test("force removes the container and worktree but never touches a remote branch", async () => {
    await spawnAcme();
    state.dirty.add("acme-login");
    await runtime.delete("acme-login", { force: true });
    expect(state.containers.has("workset-acme-login")).toBe(false);
    expect(fs.existsSync(path.join(root, "state", "worktrees", "acme-login"))).toBe(false);
    expect(
      gitCalls().some(
        (args) => args.includes("push") || args.includes("--delete") || args.includes("-D"),
      ),
    ).toBe(false);
  });

  test("a clean, pushed Workset is deleted without force", async () => {
    await spawnAcme();
    await runtime.delete("acme-login");
    expect(state.containers.size).toBe(0);
  });
});

describe("attach and marked stop", () => {
  test("the attach command runs as mate in the worktree, naming credential and marker without values", async () => {
    await spawnAcme();
    const argv = await runtime.attachCommand({
      id: "acme-login",
      command: ["mate", "claude"],
      session: "acme-session-0001",
      envNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    expect(argv).toEqual([
      "docker",
      "exec",
      "--interactive",
      "--tty",
      "--user",
      "mate",
      "--workdir",
      path.join(root, "state", "worktrees", "acme-login"),
      "--env",
      "MATE_FACTORY_SESSION",
      "--env",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "workset-acme-login",
      "mate",
      "claude",
    ]);
  });

  test("an attach to a paused Workset or with a bad session id is refused", async () => {
    await spawnAcme();
    await expect(
      runtime.attachCommand({ id: "acme-login", command: ["x"], session: "bad id", envNames: [] }),
    ).rejects.toThrow(/session id/);
    await runtime.pause("acme-login");
    await expect(
      runtime.attachCommand({
        id: "acme-login",
        command: ["x"],
        session: "acme-session-0001",
        envNames: [],
      }),
    ).rejects.toThrow(/paused/);
  });

  test("the marked stop runs inside a running container only", async () => {
    await spawnAcme();
    state.calls.length = 0;
    await runtime.stopMarked("acme-login", "acme-session-0001");
    expect(dockerCall("exec")!.args).toEqual([
      "exec",
      "workset-acme-login",
      "mate-workset-stop",
      "acme-session-0001",
    ]);
    await runtime.pause("acme-login");
    state.calls.length = 0;
    await runtime.stopMarked("acme-login", "acme-session-0001");
    expect(dockerCall("exec")).toBeUndefined();
  });
});

describe("broker additions", () => {
  test("exec with stdin runs interactive and hands the bytes to the command only", async () => {
    await spawnAcme();
    state.calls.length = 0;
    const stdin = new TextEncoder().encode("file body");
    await runtime.exec({ id: "acme-login", command: ["tee", "README.md"], stdin });
    const exec = dockerCall("exec")!;
    expect(exec.args.slice(0, 2)).toEqual(["exec", "--interactive"]);
    expect(exec.options.stdin).toEqual(stdin);
  });

  test("address reads the container's inner-network IP of a running Workset", async () => {
    await spawnAcme();
    expect(await runtime.address("acme-login")).toBe("172.18.0.5");
    await runtime.pause("acme-login");
    await expect(runtime.address("acme-login")).rejects.toThrow(/not running/);
  });

  test("a non-TTY attach command keeps stdin but has no terminal", async () => {
    await spawnAcme();
    const argv = await runtime.attachCommand({
      id: "acme-login",
      command: ["node", "/opt/mate/harness-bridge/index.js"],
      session: "acme-session-0003",
      envNames: [],
      tty: false,
    });
    expect(argv).toContain("--interactive");
    expect(argv).not.toContain("--tty");
  });
});
