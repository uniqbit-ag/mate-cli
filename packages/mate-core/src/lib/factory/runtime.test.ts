import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandOptions, CommandResult, CommandRunner } from "./command";
import { GitCredentialStore } from "./git-credential-store";
import { dockerSizeBytes, ROOM_GRACE_MS, WorksetRuntime } from "./runtime";

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

interface FakeContainer {
  running: boolean;
  labels: Record<string, string>;
  image: string;
  volumes: string[];
  /** `--memory` from the last create or update, as Docker reports it in bytes. */
  memory?: number;
}

interface Fake {
  run: CommandRunner;
  calls: Call[];
  containers: Map<string, FakeContainer>;
  /** The id `docker image inspect` reports for the current Workset image. */
  imageId: string;
  remoteBranches: Set<string>;
  worktreeBranches: Map<string, string | null>;
  dirty: Set<string>;
  unpushed: Map<string, number>;
  sysbox: boolean;
  /** The `origin` each checkout, by folder name, reports. */
  origins: Map<string, string>;
}

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });

function fake(): Fake {
  const state: Fake = {
    calls: [],
    containers: new Map(),
    imageId: "sha256:current",
    remoteBranches: new Set(["HEAD"]),
    worktreeBranches: new Map(),
    dirty: new Set(),
    unpushed: new Map(),
    sysbox: true,
    origins: new Map(),
    run: async () => ok(),
  };
  state.run = async (command, args, options = {}) => {
    state.calls.push({ command, args, options });
    if (command === "docker") return docker(state, args);
    return git(state, withoutConfig(args));
  };
  return state;
}

/** The arguments after the leading `-c` options every broker Git command carries. */
function withoutConfig(args: string[]): string[] {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args.slice(index);
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
      if (args.includes("{{.Id}}")) return ok(`id-${name}\n`);
      if (args.includes("{{.HostConfig.Memory}}")) return ok(`${container.memory ?? 0}\n`);
      if (args.join(" ").includes(".Image")) {
        return ok(
          `${container.image}\t${container.volumes.map((volume) => `${volume} `).join("")}\n`,
        );
      }
      return ok(String(container.running));
    }
    case "image":
      return ok(`${state.imageId}\n`);
    case "create": {
      const labels: Record<string, string> = {};
      const volumes: string[] = [];
      args.forEach((arg, index) => {
        if (arg === "--label") {
          const [key, value] = args[index + 1]!.split("=");
          labels[key!] = value!;
        }
        if (arg === "--volume" && !args[index + 1]!.startsWith("/")) {
          volumes.push(args[index + 1]!.split(":")[0]!);
        }
      });
      const memory = args.indexOf("--memory");
      state.containers.set(args[args.indexOf("--name") + 1]!, {
        running: false,
        labels,
        image: state.imageId,
        volumes,
        ...(memory === -1 ? {} : { memory: dockerSizeBytes(args[memory + 1]!)! }),
      });
      return ok();
    }
    case "update": {
      const container = state.containers.get(name);
      const memory = args.indexOf("--memory");
      if (container && memory !== -1) container.memory = dockerSizeBytes(args[memory + 1]!)!;
      return ok();
    }
    case "volume":
    case "cp":
      return ok();
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
      if (args.includes("status=running")) {
        return ok(
          [...state.containers.values()]
            .filter((container) => container.running)
            .map((container) => container.labels["dev.mate.workset"])
            .join("\n"),
        );
      }
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
    case "symbolic-ref": {
      const branch = state.worktreeBranches.has(path.basename(dir))
        ? state.worktreeBranches.get(path.basename(dir))
        : `workset/${path.basename(dir)}`;
      return branch ? ok(`${branch}\n`) : failed("detached HEAD");
    }
    case "clone":
      fs.mkdirSync(path.join(rest.at(-1)!, ".git", "worktrees"), { recursive: true });
      return ok();
    case "fetch":
      return ok();
    case "ls-remote":
      return ok("abc123\tHEAD\n");
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
    case "remote": {
      const origin = state.origins.get(path.basename(dir));
      return origin ? ok(`${origin}\n`) : failed("no such remote");
    }
    case "status":
      return ok(state.dirty.has(path.basename(dir)) ? " M src/app.ts\n" : "");
    case "log":
      return ok(
        Array.from(
          { length: state.unpushed.get(path.basename(dir)) ?? 0 },
          (_, index) => `abc${index} Add step ${index + 1}`,
        ).join("\n"),
      );
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
  state.calls.filter((call) => call.command === "git").map((call) => withoutConfig(call.args));
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

describe("Git tokens", () => {
  const TOKEN = "acme-git-token";
  const clone = () =>
    state.calls.find((call) => call.command === "git" && call.args.includes("clone"))!;

  function withToken(): void {
    const store = new GitCredentialStore(path.join(root, "git-credentials.json"), null);
    store.set("git.acme.test/acme", TOKEN);
    runtime = new WorksetRuntime({
      dockerHost: `unix://${root}/docker.sock`,
      stateDir: path.join(root, "state"),
      image: "mate-workset:1.0.0-acme",
      user: "mate",
      companionsDir: path.join(root, "companions"),
      gitCredentials: store,
      run: state.run,
    });
  }

  test("the Workset clone and fetch carry the matching token in their environment only, past configured helpers", async () => {
    withToken();
    await spawnAcme();
    await spawnAcme("acme-signup");
    const calls = state.calls.filter(
      (call) =>
        call.command === "git" && (call.args.includes("clone") || call.args.includes("fetch")),
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.options.env?.MATE_GIT_ASKPASS_TOKEN).toBe(TOKEN);
      expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(JSON.stringify(call.args)).not.toContain(TOKEN);
      // No configured credential helper answers first or stores the token.
      expect(call.args.slice(0, 4)).toEqual([
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "credential.helper=",
      ]);
    }
    const askpass = calls[0]!.options.env!.GIT_ASKPASS!;
    expect(fs.statSync(askpass).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(askpass, "utf8")).not.toContain(TOKEN);
  });

  test("commands that talk to no remote carry no token", async () => {
    withToken();
    await spawnAcme();
    const others = state.calls.filter(
      (call) => call.command === "git" && !call.args.includes("clone"),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const call of others) expect(call.options.env?.MATE_GIT_ASKPASS_TOKEN).toBeUndefined();
  });

  test("a remote with no matching token gets no token, and prompts stay off", async () => {
    withToken();
    await runtime.spawn({
      id: "acme-other",
      repository: "other/app",
      remoteUrl: "https://git.example.test/other/app.git",
      companion,
    });
    expect(clone().options.env?.MATE_GIT_ASKPASS_TOKEN).toBeUndefined();
    expect(clone().options.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(clone().args).not.toContain("credential.helper=");
  });

  test("an SSH remote gets no token", async () => {
    withToken();
    await runtime.spawn({
      id: "acme-ssh",
      repository: "acme/app",
      remoteUrl: "git@git.acme.test:acme/app.git",
      companion,
    });
    expect(clone().options.env?.MATE_GIT_ASKPASS_TOKEN).toBeUndefined();
  });

  test("a refused clone names the host and organization and never the token", async () => {
    const run = state.run;
    state.run = async (command, args, options) =>
      command === "git" && args.includes("clone")
        ? failed(`fatal: Authentication failed for 'https://x:${TOKEN}@git.acme.test/acme/app.git'`)
        : run(command, args, options);
    withToken();
    const error = await spawnAcme().catch((caught) => caught as Error & { code?: string });
    expect(error.message).toContain("git.acme.test/acme");
    expect(error.message).toContain("token");
    expect(error.message).not.toContain(TOKEN);
    expect(error.code).toBe("auth");
  });
});

describe("cloneCompanion", () => {
  const URL = "https://git.acme.test/acme/acme-companion.git";
  const target = () => path.join(root, "companions", "acme-companion");
  const clones = () => gitCalls().filter((args) => args[0] === "clone");

  test("clones into a folder named after the repository, as the Git user, with prompts off", async () => {
    expect(await runtime.cloneCompanion(URL)).toEqual({ path: target(), existing: false });
    expect(clones()).toEqual([["clone", "--", URL, target()]]);
    const call = state.calls.find((entry) => entry.args.includes("clone"))!;
    expect(call.options.asUser).toBe("mate");
    expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(call.options.timeoutMs).toBeGreaterThan(0);
  });

  test("uses the stored token for the URL and keeps it out of the arguments", async () => {
    const store = new GitCredentialStore(path.join(root, "git-credentials.json"), null);
    store.set("git.acme.test/acme", "acme-git-token");
    runtime = new WorksetRuntime({
      dockerHost: `unix://${root}/docker.sock`,
      stateDir: path.join(root, "state"),
      image: "mate-workset:1.0.0-acme",
      user: "mate",
      companionsDir: path.join(root, "companions"),
      gitCredentials: store,
      run: state.run,
    });
    await runtime.cloneCompanion(URL);
    const call = state.calls.find((entry) => entry.args.includes("clone"))!;
    expect(call.options.env?.MATE_GIT_ASKPASS_TOKEN).toBe("acme-git-token");
    expect(JSON.stringify(call.args)).not.toContain("acme-git-token");
  });

  test("a checkout of the same repository is reported, not cloned again", async () => {
    await runtime.cloneCompanion(URL);
    state.origins.set("acme-companion", "git@git.acme.test:acme/acme-companion.git");
    expect(await runtime.cloneCompanion(URL)).toEqual({ path: target(), existing: true });
    expect(clones()).toHaveLength(1);
  });

  test("a folder held by another repository is refused and left alone", async () => {
    await runtime.cloneCompanion(URL);
    state.origins.set("acme-companion", "https://git.acme.test/other/acme-companion.git");
    await expect(runtime.cloneCompanion(URL)).rejects.toThrow(/different repository/);
    expect(fs.existsSync(path.join(target(), ".git"))).toBe(true);
  });

  test.each([
    "/srv/companion",
    "file:///srv/companion",
    "ext::sh -c id",
    "--upload-pack=id",
    "https://git.acme.test/web.git",
    "",
  ])("%j is refused before anything runs", async (url) => {
    await expect(Promise.resolve().then(() => runtime.cloneCompanion(url))).rejects.toThrow();
    expect(clones()).toEqual([]);
  });

  test("a failed clone leaves no folder, and a refusal names the host and organization", async () => {
    const run = state.run;
    state.run = async (command, args, options) => {
      if (command === "git" && args.includes("clone")) {
        fs.mkdirSync(args.at(-1)!, { recursive: true });
        return failed(
          "fatal: Authentication failed for 'https://git.acme.test/acme/acme-companion.git'",
        );
      }
      return run(command, args, options);
    };
    runtime = new WorksetRuntime({
      dockerHost: `unix://${root}/docker.sock`,
      stateDir: path.join(root, "state"),
      image: "mate-workset:1.0.0-acme",
      user: "mate",
      companionsDir: path.join(root, "companions"),
      run: state.run,
    });
    const error = await runtime
      .cloneCompanion(URL)
      .catch((caught) => caught as Error & { code?: string });
    expect(error.code).toBe("auth");
    expect(error.message).toContain("git.acme.test/acme");
    expect(fs.existsSync(target())).toBe(false);
  });
});

describe("checkRemote", () => {
  const URL = "https://git.acme.test/acme/web.git";
  const lsRemote = () => state.calls.find((call) => call.args.includes("ls-remote"))!;

  test("asks the remote for its HEAD as the Git user, with prompts off and a time limit", async () => {
    await runtime.checkRemote(URL);
    expect(withoutConfig(lsRemote().args)).toEqual(["ls-remote", "--", URL, "HEAD"]);
    expect(lsRemote().options.asUser).toBe("mate");
    expect(lsRemote().options.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(lsRemote().options.timeoutMs).toBeGreaterThan(0);
  });

  test("uses the stored token and keeps it out of the arguments", async () => {
    const store = new GitCredentialStore(path.join(root, "git-credentials.json"), null);
    store.set("git.acme.test", "acme-git-token");
    runtime = new WorksetRuntime({
      dockerHost: `unix://${root}/docker.sock`,
      stateDir: path.join(root, "state"),
      image: "mate-workset:1.0.0-acme",
      user: "mate",
      companionsDir: path.join(root, "companions"),
      gitCredentials: store,
      run: state.run,
    });
    await runtime.checkRemote(URL);
    expect(lsRemote().options.env?.MATE_GIT_ASKPASS_TOKEN).toBe("acme-git-token");
    expect(JSON.stringify(lsRemote().args)).not.toContain("acme-git-token");
  });

  test("a refusal for authentication names the host and organization and carries its code", async () => {
    const run = state.run;
    state.run = async (command, args, options) =>
      command === "git" && args.includes("ls-remote")
        ? failed(
            "fatal: could not read Username for 'https://git.acme.test': terminal prompts disabled",
          )
        : run(command, args, options);
    runtime = new WorksetRuntime({
      dockerHost: `unix://${root}/docker.sock`,
      stateDir: path.join(root, "state"),
      image: "mate-workset:1.0.0-acme",
      user: "mate",
      companionsDir: path.join(root, "companions"),
      run: state.run,
    });
    const error = await runtime
      .checkRemote(URL)
      .catch((caught) => caught as Error & { code?: string });
    expect(error.code).toBe("auth");
    expect(error.message).toContain("git.acme.test/acme");
  });

  test("a remote that does not answer is reported with Git's words", async () => {
    const run = state.run;
    state.run = async (command, args, options) =>
      command === "git" && args.includes("ls-remote")
        ? failed("fatal: repository 'https://git.acme.test/acme/web.git/' not found")
        : run(command, args, options);
    runtime = new WorksetRuntime({
      dockerHost: `unix://${root}/docker.sock`,
      stateDir: path.join(root, "state"),
      image: "mate-workset:1.0.0-acme",
      user: "mate",
      companionsDir: path.join(root, "companions"),
      run: state.run,
    });
    const error = await runtime
      .checkRemote(URL)
      .catch((caught) => caught as Error & { code?: string });
    expect(error.message).toContain("not found");
    expect(error.code).toBeUndefined();
  });

  test.each(["/srv/web", "file:///srv/web", "--upload-pack=id", ""])(
    "%j is refused before Git runs",
    async (url) => {
      await expect(Promise.resolve().then(() => runtime.checkRemote(url))).rejects.toThrow();
      expect(state.calls.some((call) => call.args.includes("ls-remote"))).toBe(false);
    },
  );
});

describe("spawn", () => {
  test("clones once and creates workset/<workset> from the remote default branch", async () => {
    const info = await spawnAcme();
    expect(info).toEqual({
      id: "acme-login",
      repository: "acme/app",
      branch: "workset/acme-login",
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
      "workset/acme-login",
      path.join(root, "state", "worktrees", "acme-login"),
      "origin/HEAD",
    ]);

    await spawnAcme("acme-signup");
    expect(gitCalls().filter((args) => args[0] === "clone")).toHaveLength(1);
    expect(gitCalls()).toContainEqual(["-C", repo, "fetch", "--prune", "origin"]);
  });

  test("an existing remote Delivery Branch is checked out", async () => {
    state.remoteBranches.add("workset/acme-login");
    await spawnAcme();
    expect(gitCalls().find((args) => args[2] === "worktree")).toContain(
      "origin/workset/acme-login",
    );
  });

  test("the Workset record's ticket names the new Delivery Branch", async () => {
    fs.mkdirSync(path.join(companion, "worksets"));
    fs.writeFileSync(
      path.join(companion, "worksets/acme-login.yaml"),
      "id: acme-login\nticket: ABC-123\nrepositories: [acme/app]\nchanges: []\n",
    );
    const info = await spawnAcme();
    expect(info.branch).toBe("workset/ABC-123-acme-login");
    expect(gitCalls().find((args) => args[2] === "worktree")).toContain(
      "workset/ABC-123-acme-login",
    );
  });

  test("a member's recorded branch is the new Delivery Branch", async () => {
    fs.mkdirSync(path.join(companion, "worksets"));
    fs.writeFileSync(
      path.join(companion, "worksets/acme-login.yaml"),
      "id: acme-login\nrepositories: [acme/app]\nchanges: [acme-form]\n",
    );
    const form = path.join(companion, "openspec/changes/acme-form");
    fs.mkdirSync(form, { recursive: true });
    fs.writeFileSync(
      path.join(form, "delivery.yaml"),
      "version: 1\nchange: acme-form\ndeliveries:\n  - repository: acme/app\n    branch: workset/ABC-123-acme-login\n",
    );
    const info = await spawnAcme();
    expect(info.branch).toBe("workset/ABC-123-acme-login");
    expect(gitCalls().find((args) => args[2] === "worktree")).toContain(
      "workset/ABC-123-acme-login",
    );
  });

  test("a dependency squash-merged in the clone is not inherited and is a spawn warning", async () => {
    const changes = path.join(companion, "openspec/changes");
    fs.mkdirSync(path.join(changes, "acme-api"), { recursive: true });
    fs.mkdirSync(path.join(changes, "acme-worker"), { recursive: true });
    fs.writeFileSync(
      path.join(changes, "acme-worker/proposal.md"),
      "---\nchange: acme-worker\ndependsOn: [acme-api]\n---\n",
    );
    fs.writeFileSync(
      path.join(changes, "acme-api/delivery.yaml"),
      "version: 1\nchange: acme-api\ndeliveries:\n  - repository: acme/app\n    branch: workset/acme-api\n",
    );
    state.remoteBranches.add("workset/acme-api");
    // The clone holds workset/acme-api's one commit squashed onto origin/main.
    const plain = state.run;
    const run: CommandRunner = async (command, args, options = {}) => {
      const rest = args.slice(4);
      const line = rest.join(" ");
      if (command !== "git" || args[2] !== "-C") return plain(command, args, options);
      state.calls.push({ command, args, options });
      if (line === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return ok("origin/main\n");
      }
      if (line === "rev-parse --verify --quiet refs/remotes/origin/workset/acme-api^{commit}") {
        return ok("head1\n");
      }
      if (rest[0] === "merge-base" && rest[1] === "--is-ancestor") return failed("");
      if (rest[0] === "config") return failed("");
      if (rest[0] === "merge-base") return ok("fork1\n");
      if (rest[0] === "rev-list") return ok("1\n");
      if (rest[0] === "log" && rest[1] === "-p") return ok(`patch of ${rest.at(-1)}\n`);
      if (rest[0] === "patch-id") {
        const input = new TextDecoder().decode(options.stdin);
        return ok(input.includes("..head1") ? "pid1 head1\n" : "pid1 up1\n");
      }
      return plain(command, args, options);
    };
    const probing = new WorksetRuntime({
      dockerHost: `unix://${root}/docker.sock`,
      stateDir: path.join(root, "state"),
      image: "mate-workset:1.0.0-acme",
      user: "mate",
      companionsDir: path.join(root, "companions"),
      run,
    });

    const info = await probing.spawn({
      id: "acme-worker",
      repository: "acme/app",
      remoteUrl: "https://git.acme.test/acme/app.git",
      companion,
    });
    expect(info.branch).toBe("workset/acme-worker");
    expect(info.warnings?.join()).toContain("`mate artifact link acme-api --confirm-open`");
    // The probe ran in the clone, as the unprivileged user, with ext:: refused.
    const probe = state.calls.find((call) => call.args.includes("patch-id"))!;
    expect(probe.options.asUser).toBe("mate");
    expect(probe.options.timeoutMs).toBeGreaterThan(0);
    expect(probe.args.slice(0, 4)).toEqual([
      "-c",
      "protocol.ext.allow=never",
      "-C",
      path.join(root, "state", "repos", "acme__app"),
    ]);
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

  test("a collision refuses branch creation or reuse before Git runs", async () => {
    fs.mkdirSync(path.join(companion, "worksets"));
    fs.writeFileSync(
      path.join(companion, "worksets/acme-login.yaml"),
      "id: acme-login\nrepositories: [acme/app]\nchanges: [acme-form]\n",
    );
    fs.mkdirSync(path.join(companion, "openspec/changes/acme-login"), { recursive: true });
    state.remoteBranches.add("workset/acme-login");
    await expect(spawnAcme()).rejects.toThrow(
      /Workset acme-login and standalone change acme-login collide/,
    );
    expect(gitCalls()).toEqual([]);
  });

  test("regrouping does not switch an existing worktree", async () => {
    await spawnAcme();
    fs.mkdirSync(path.join(companion, "worksets"));
    fs.writeFileSync(
      path.join(companion, "worksets/acme-login.yaml"),
      "id: acme-login\nrepositories: [acme/app]\nchanges: [acme-form]\n",
    );
    fs.mkdirSync(path.join(companion, "openspec/changes/acme-login"), { recursive: true });
    state.calls.length = 0;
    await spawnAcme();
    expect(gitCalls().some((args) => args.includes("worktree") || args.includes("switch"))).toBe(
      false,
    );
  });

  test.each(["change/acme-login", "feature/acme-login"])(
    "existing worktree keeps %s in spawn and list",
    async (branch) => {
      await spawnAcme();
      state.worktreeBranches.set("acme-login", branch);
      state.calls.length = 0;
      expect((await spawnAcme()).branch).toBe(branch);
      expect((await runtime.list())[0].branch).toBe(branch);
      expect(gitCalls().some((args) => args.includes("worktree") || args.includes("switch"))).toBe(
        false,
      );
    },
  );

  test("detached existing worktree refuses spawn and list without branch inference", async () => {
    await spawnAcme();
    state.worktreeBranches.set("acme-login", null);
    state.calls.length = 0;
    await expect(spawnAcme()).rejects.toThrow(/detached or unreadable HEAD/);
    await expect(runtime.list()).rejects.toThrow(/detached or unreadable HEAD/);
    expect(gitCalls().some((args) => args.includes("worktree") || args.includes("switch"))).toBe(
      false,
    );
  });

  test("git runs as the unprivileged user, docker as the broker", async () => {
    await spawnAcme();
    for (const call of state.calls) {
      expect(call.options.asUser).toBe(call.command === "git" ? "mate" : undefined);
    }
  });

  test("the container is unprivileged Sysbox with labels, three identical-path mounts, its home and the Bun cache", async () => {
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
      "workset-home-acme-login:/home/mate",
      "workset-bun-cache:/var/cache/bun",
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
      { id: "acme-a", repository: "acme/app", branch: "workset/acme-a", state: "running" },
      { id: "acme-b", repository: "acme/app", branch: "workset/acme-b", state: "paused" },
      { id: "acme-c", repository: "acme/app", branch: "workset/acme-c", state: "missing" },
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
      /uncommitted changes and 2 unpushed commit\(s\) \(abc0 Add step 1; abc1 Add step 2\)/,
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

function limitedRuntime(options: Partial<ConstructorParameters<typeof WorksetRuntime>[0]> = {}) {
  return new WorksetRuntime({
    dockerHost: `unix://${root}/docker.sock`,
    stateDir: path.join(root, "state"),
    image: "mate-workset:1.0.0-acme",
    user: "mate",
    companionsDir: path.join(root, "companions"),
    run: state.run,
    cgroupRoot: "/acme/cgroup",
    writeFile: () => {},
    ...options,
  });
}

const spawnWith = (subject: WorksetRuntime, id: string) =>
  subject.spawn({
    id,
    repository: "acme/app",
    remoteUrl: "https://git.acme.test/acme/app.git",
    companion,
  });

const dockerCalls = (verb: string) =>
  state.calls.filter((call) => call.command === "docker" && call.args[0] === verb);

describe("resource limits", () => {
  const limits = { memory: "4g", pids: 1024, cpus: null };

  test("a new container is created with memory, swap equal to it, and pids; no CPU limit unless set", async () => {
    await spawnWith(limitedRuntime({ limits }), "acme-login");
    const create = dockerCall("create")!.args.join(" ");
    expect(create).toContain("--memory 4g --memory-swap 4g --pids-limit 1024");
    expect(create).not.toContain("--cpus");

    await spawnWith(limitedRuntime({ limits: { ...limits, cpus: "1.5" } }), "acme-signup");
    expect(dockerCalls("create").at(-1)!.args.join(" ")).toContain("--cpus 1.5");
  });

  test("an existing container is updated to the current limits before it starts", async () => {
    await spawnWith(limitedRuntime({ limits }), "acme-login");
    const lowered = limitedRuntime({ limits: { ...limits, memory: "2g" } });
    await lowered.pause("acme-login");
    state.calls.length = 0;
    await lowered.resume("acme-login");
    const verbs = state.calls
      .filter((call) => call.command === "docker")
      .map((call) => call.args[0]);
    expect(verbs.indexOf("update")).toBeLessThan(verbs.indexOf("start"));
    expect(dockerCall("update")!.args).toEqual([
      "update",
      "--memory",
      "2g",
      "--memory-swap",
      "2g",
      "--pids-limit",
      "1024",
      "workset-acme-login",
    ]);
  });
});

describe("memory sizes", () => {
  const limits = { memory: "4g", agentMemory: "1536m", pids: 1024, cpus: null };
  const sized = (subject: WorksetRuntime, id: string, size?: "agent" | "build") =>
    subject.spawn({
      id,
      repository: "acme/app",
      remoteUrl: "https://git.acme.test/acme/app.git",
      companion,
      ...(size ? { size } : {}),
    });
  const memoryOf = (id: string) => state.containers.get(`workset-${id}`)!.memory;
  let writes: [string, string][];
  const record = (file: string, data: string) => void writes.push([file, data]);

  beforeEach(() => {
    writes = [];
  });

  test("a container spawned for an agent stage is created at the agent size", async () => {
    await sized(limitedRuntime({ limits }), "acme-greet", "agent");
    expect(dockerCall("create")!.args.join(" ")).toContain("--memory 1536m --memory-swap 1536m");
  });

  test("a spawn without a size gets the build size, as before", async () => {
    await sized(limitedRuntime({ limits }), "acme-greet");
    expect(dockerCall("create")!.args.join(" ")).toContain("--memory 4g --memory-swap 4g");
  });

  test("a running container grows for a build, with its soft limit at the new size", async () => {
    const subject = limitedRuntime({ limits, writeFile: record });
    await sized(subject, "acme-greet", "agent");
    await sized(subject, "acme-greet", "build");
    expect(memoryOf("acme-greet")).toBe(4 * 1024 ** 3);
    expect(writes.at(-1)).toEqual([
      "/acme/cgroup/docker/id-workset-acme-greet/memory.high",
      String(Math.floor(0.9 * 4 * 1024 ** 3)),
    ]);
  });

  test("an idle running container shrinks for an agent stage", async () => {
    const subject = limitedRuntime({ limits });
    await sized(subject, "acme-greet", "build");
    await sized(subject, "acme-greet", "agent");
    expect(memoryOf("acme-greet")).toBe(1536 * 1024 ** 2);
  });

  test("a container with a person's session keeps its larger limit", async () => {
    const subject = limitedRuntime({ limits });
    await sized(subject, "acme-greet", "build");
    const end = subject.beginSession("acme-greet");
    state.calls.length = 0;
    await sized(subject, "acme-greet", "agent");
    expect(dockerCalls("update")).toEqual([]);
    expect(memoryOf("acme-greet")).toBe(4 * 1024 ** 3);
    end();
  });

  test("the same size again updates nothing", async () => {
    const subject = limitedRuntime({ limits });
    await sized(subject, "acme-greet", "agent");
    state.calls.length = 0;
    await sized(subject, "acme-greet", "agent");
    expect(dockerCalls("update")).toEqual([]);
  });

  test("after a broker restart, the size is read from the running container", async () => {
    await sized(limitedRuntime({ limits }), "acme-greet", "agent");
    const restarted = limitedRuntime({ limits });
    state.calls.length = 0;
    await sized(restarted, "acme-greet", "agent");
    expect(dockerCalls("update")).toEqual([]);
    await sized(restarted, "acme-greet", "build");
    expect(memoryOf("acme-greet")).toBe(4 * 1024 ** 3);
  });

  test("a failed update is logged and the container runs on at its limit", async () => {
    const subject = limitedRuntime({ limits });
    await sized(subject, "acme-greet", "agent");
    const run = state.run;
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const refusing: CommandRunner = async (command, args, options) =>
        command === "docker" && args[0] === "update"
          ? failed("cannot update")
          : run(command, args, options);
      const restarted = limitedRuntime({ limits, run: refusing });
      const info = await sized(restarted, "acme-greet", "build");
      expect(info.state).toBe("running");
      expect(memoryOf("acme-greet")).toBe(1536 * 1024 ** 2);
      expect(String(stderr.mock.calls.at(-1)![0])).toContain(
        "Workset acme-greet keeps its memory limit: cannot update",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("an unknown size is refused", async () => {
    await expect(sized(limitedRuntime({ limits }), "acme-greet", "huge" as never)).rejects.toThrow(
      /agent or build/,
    );
  });
});

describe("the soft memory limit", () => {
  const limits = { memory: "4g", pids: 1024, cpus: null };
  let writes: [string, string][];
  const record = (file: string, data: string) => void writes.push([file, data]);
  const memoryHigh = "/acme/cgroup/docker/id-workset-acme-login/memory.high";

  beforeEach(() => {
    writes = [];
  });

  test("reads Docker sizes in bytes", () => {
    expect(dockerSizeBytes("4g")).toBe(4 * 1024 ** 3);
    expect(dockerSizeBytes("512m")).toBe(512 * 1024 ** 2);
    expect(dockerSizeBytes("64K")).toBe(64 * 1024);
    expect(dockerSizeBytes("1000b")).toBe(1000);
    expect(dockerSizeBytes("1000")).toBe(1000);
    expect(dockerSizeBytes("4 gigs")).toBeNull();
  });

  test("is 90% of a 4g limit, written to the container's cgroup after start", async () => {
    await spawnWith(limitedRuntime({ limits, writeFile: record }), "acme-login");
    expect(writes).toEqual([[memoryHigh, "3865470566"]]);
    const calls = state.calls
      .filter((call) => call.command === "docker")
      .map((call) => call.args.join(" "));
    expect(calls.findIndex((call) => call.includes("{{.Id}}"))).toBeGreaterThan(
      calls.indexOf("start workset-acme-login"),
    );
  });

  test("is written again after a resume", async () => {
    const subject = limitedRuntime({ limits, writeFile: record });
    await spawnWith(subject, "acme-login");
    await subject.pause("acme-login");
    await subject.resume("acme-login");
    expect(writes).toEqual([
      [memoryHigh, "3865470566"],
      [memoryHigh, "3865470566"],
    ]);
  });

  test("a missing cgroup file starts the container and logs naming the Workset", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const missing = () => {
        throw new Error("ENOENT: no such file or directory");
      };
      const info = await spawnWith(limitedRuntime({ limits, writeFile: missing }), "acme-login");
      expect(info.state).toBe("running");
      expect(state.containers.get("workset-acme-login")!.running).toBe(true);
      expect(String(stderr.mock.calls.at(-1)![0])).toContain(
        "Workset acme-login runs without a soft memory limit",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("no memory limit, no write", async () => {
    await spawnWith(limitedRuntime({ writeFile: record }), "acme-login");
    expect(writes).toEqual([]);
    expect(dockerCalls("container").some((call) => call.args.includes("{{.Id}}"))).toBe(false);
  });
});

describe("the running-container cap", () => {
  let clock: number;
  let capped: WorksetRuntime;

  beforeEach(() => {
    clock = 1_000_000;
    capped = limitedRuntime({ maxWorksets: 2, now: () => clock });
  });

  test("an idle container makes room: the least recently active one is pruned and stopped", async () => {
    await spawnWith(capped, "acme-a");
    clock += ROOM_GRACE_MS;
    await spawnWith(capped, "acme-b");
    clock += ROOM_GRACE_MS;
    state.calls.length = 0;
    await spawnWith(capped, "acme-c");

    expect(state.containers.get("workset-acme-a")!.running).toBe(false);
    expect(state.containers.get("workset-acme-b")!.running).toBe(true);
    expect(state.containers.get("workset-acme-c")!.running).toBe(true);
    const prune = dockerCalls("exec").find((call) => call.args.includes("mate-workset-prune"))!;
    expect(prune.args).toEqual(["exec", "workset-acme-a", "mate-workset-prune"]);
  });

  test("when every running container is busy the spawn is refused naming the cap, and nothing changes", async () => {
    await spawnWith(capped, "acme-a");
    await spawnWith(capped, "acme-b");
    capped.beginSession("acme-a");
    const exec = capped.exec({ id: "acme-b", command: ["sleep"] });
    await exec;
    capped.beginSession("acme-b");
    state.calls.length = 0;

    const refused = spawnWith(capped, "acme-c");
    await expect(refused).rejects.toThrow(/2 running Workset containers are busy.*at most 2/);
    await refused.catch((error: { code?: string }) => expect(error.code).toBe("busy"));
    expect(dockerCalls("stop")).toEqual([]);
    expect(dockerCalls("create")).toEqual([]);
    expect(fs.existsSync(path.join(root, "state", "worktrees", "acme-c"))).toBe(false);
  });

  test("a container active within the grace period is not stopped to make room", async () => {
    await spawnWith(capped, "acme-a");
    await spawnWith(capped, "acme-b");
    clock += ROOM_GRACE_MS - 1;
    state.calls.length = 0;
    await expect(spawnWith(capped, "acme-c")).rejects.toThrow(/busy/);
    expect(dockerCalls("stop")).toEqual([]);
  });

  test("resuming over the cap makes room the same way", async () => {
    await spawnWith(capped, "acme-a");
    await capped.pause("acme-a");
    clock += ROOM_GRACE_MS;
    await spawnWith(capped, "acme-b");
    clock += ROOM_GRACE_MS;
    await spawnWith(capped, "acme-c");
    await capped.resume("acme-a");
    expect(state.containers.get("workset-acme-a")!.running).toBe(true);
    expect(state.containers.get("workset-acme-b")!.running).toBe(false);
  });
});

describe("idle stop", () => {
  let clock: number;
  let idle: WorksetRuntime;

  beforeEach(() => {
    clock = 1_000_000;
    idle = limitedRuntime({ idleMinutes: 15, now: () => clock });
  });

  test("a container idle past the idle minutes is pruned, then stopped; its worktree stays", async () => {
    await spawnWith(idle, "acme-login");
    clock += 14 * 60_000;
    expect(await idle.sweepIdle()).toEqual([]);
    clock += 2 * 60_000;
    state.calls.length = 0;
    expect(await idle.sweepIdle()).toEqual(["acme-login"]);
    const verbs = state.calls
      .filter((call) => call.command === "docker")
      .map((call) => call.args[0]);
    expect(verbs.indexOf("exec")).toBeLessThan(verbs.indexOf("stop"));
    expect(state.containers.get("workset-acme-login")!.running).toBe(false);
    expect(fs.existsSync(path.join(root, "state", "worktrees", "acme-login", ".git"))).toBe(true);
  });

  test("an attached session keeps a container running however long it lasts", async () => {
    await spawnWith(idle, "acme-login");
    const end = idle.beginSession("acme-login");
    clock += 120 * 60_000;
    expect(await idle.sweepIdle()).toEqual([]);
    end();
    clock += 14 * 60_000;
    expect(await idle.sweepIdle()).toEqual([]);
    clock += 2 * 60_000;
    expect(await idle.sweepIdle()).toEqual(["acme-login"]);
  });

  test("a command in progress counts as activity", async () => {
    let finish!: () => void;
    const blocking: CommandRunner = async (command, args, options) => {
      if (command === "docker" && args[0] === "exec" && args.includes("long")) {
        await new Promise<void>((resolve) => (finish = resolve));
      }
      return state.run(command, args, options);
    };
    idle = limitedRuntime({ idleMinutes: 15, now: () => clock, run: blocking });
    await spawnWith(idle, "acme-login");
    const running = idle.exec({ id: "acme-login", command: ["long"] });
    await Bun.sleep(5);
    clock += 60 * 60_000;
    expect(idle.isIdle("acme-login")).toBe(false);
    expect(await idle.sweepIdle()).toEqual([]);
    finish();
    await running;
    expect(idle.isIdle("acme-login")).toBe(true);
  });

  test("an idle time of 0 never stops a container", async () => {
    const never = limitedRuntime({ idleMinutes: 0, now: () => clock });
    await spawnWith(never, "acme-login");
    clock += 24 * 60 * 60_000;
    expect(await never.sweepIdle()).toEqual([]);
  });

  test("a stopped container starts again on its next spawn", async () => {
    await spawnWith(idle, "acme-login");
    clock += 16 * 60_000;
    await idle.sweepIdle();
    await spawnWith(idle, "acme-login");
    expect(state.containers.get("workset-acme-login")!.running).toBe(true);
    expect(dockerCalls("create")).toHaveLength(1);
  });
});

describe("the home volume and the current image", () => {
  test("deleting a Workset removes its home volume", async () => {
    await spawnAcme();
    await runtime.delete("acme-login");
    expect(dockerCall("volume")!.args).toEqual([
      "volume",
      "rm",
      "--force",
      "workset-home-acme-login",
    ]);
  });

  test("a container from an earlier image is recreated on spawn; its home volume stays", async () => {
    await spawnAcme();
    await runtime.pause("acme-login");
    state.imageId = "sha256:next";
    state.calls.length = 0;
    await spawnAcme();
    expect(dockerCall("rm")!.args).toEqual(["rm", "--force", "workset-acme-login"]);
    expect(dockerCall("create")).toBeDefined();
    expect(dockerCall("cp")).toBeUndefined();
    expect(state.containers.get("workset-acme-login")!.image).toBe("sha256:next");
    expect(fs.existsSync(path.join(root, "state", "worktrees", "acme-login", ".git"))).toBe(true);
  });

  test("a container from before the home volume has its home copied to the volume first", async () => {
    await spawnAcme();
    await runtime.pause("acme-login");
    const old = state.containers.get("workset-acme-login")!;
    old.volumes = [];
    state.imageId = "sha256:next";
    state.calls.length = 0;
    await spawnAcme();
    const docker = state.calls.filter((call) => call.command === "docker").map((call) => call.args);
    const stage = path.join(root, "state", "home-migration", "acme-login");
    const save = docker.findIndex(
      (args) => args[0] === "cp" && args[2] === "workset-acme-login:/home/mate",
    );
    const remove = docker.findIndex((args) => args[0] === "rm");
    const create = docker.findIndex((args) => args[0] === "create");
    const restore = docker.findIndex(
      (args) => args[0] === "cp" && args[3] === "workset-acme-login:/home/mate",
    );
    expect(docker[save]).toEqual(["cp", "--archive", "workset-acme-login:/home/mate", stage]);
    expect(docker[restore]).toEqual([
      "cp",
      "--archive",
      `${stage}/mate/.`,
      "workset-acme-login:/home/mate",
    ]);
    expect(save).toBeLessThan(remove);
    expect(remove).toBeLessThan(create);
    expect(create).toBeLessThan(restore);
    const start = docker.findIndex((args) => args[0] === "start");
    const chown = docker.findIndex((args) => args.includes("chown"));
    expect(docker[chown]).toEqual([
      "exec",
      "workset-acme-login",
      "chown",
      "-R",
      "mate:mate",
      "/home/mate",
    ]);
    expect(start).toBeLessThan(chown);
    expect(fs.existsSync(stage)).toBe(false);
  });

  test("a running container in use is not recreated", async () => {
    await spawnAcme();
    runtime.beginSession("acme-login");
    state.imageId = "sha256:next";
    state.calls.length = 0;
    await spawnAcme();
    expect(dockerCall("rm")).toBeUndefined();
  });

  test("a container from the current image is kept", async () => {
    await spawnAcme();
    await runtime.pause("acme-login");
    state.calls.length = 0;
    await spawnAcme();
    expect(dockerCall("rm")).toBeUndefined();
    expect(dockerCall("create")).toBeUndefined();
  });
});
