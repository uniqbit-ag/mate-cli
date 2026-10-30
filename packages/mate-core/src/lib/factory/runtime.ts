import fs from "node:fs";
import path from "node:path";

import { type CommandResult, type CommandRunner, runCommand } from "./command";
import {
  assertRepository,
  assertWorksetId,
  containerName,
  deliveryBranch,
  FactoryError,
  LABEL_REPOSITORY,
  LABEL_WORKSET,
  repoKey,
  repositoryFromKey,
} from "./ids";

/**
 * The Workset runtime: one unprivileged Sysbox container per Workset, with its
 * own worktree on `change/<workset>`, driven through the inner Docker daemon.
 *
 * Runs inside the factory broker, which alone holds the inner socket. Callers
 * name a Workset, a repository and a command; image, mounts, runtime and
 * flags are fixed here. Git runs as the unprivileged user so clones and
 * worktrees keep the uid the Workset containers share.
 */

export type WorksetState = "running" | "paused" | "missing";

export interface WorksetInfo {
  id: string;
  repository: string | null;
  branch: string;
  state: WorksetState;
}

export interface SpawnRequest {
  id: string;
  repository: string;
  /** Where to clone from when the factory has no clone yet. */
  remoteUrl: string;
  /** The Session Companion, mounted read-write at the same path. */
  companion: string;
}

export interface ExecRequest {
  id: string;
  command: string[];
  /** Per-command environment; values reach only this command. */
  env?: Record<string, string>;
  /** Working directory relative to the worktree. */
  cwd?: string;
  /** Standard input for the command, closed after it is written. */
  stdin?: Uint8Array;
}

export interface RuntimeOptions {
  dockerHost: string;
  stateDir: string;
  image: string;
  /** The unprivileged user Git and Workset commands run as. */
  user: string;
  /** Companions must resolve inside this directory. */
  companionsDir: string;
  run?: CommandRunner;
  exists?: (file: string) => boolean;
  realpath?: (file: string) => string;
  listDir?: (dir: string) => string[];
}

const SYSBOX_RUNTIME = "sysbox-runc";

/** Set on every process an attach starts in a Workset container, so a stop finds them all. */
export const SESSION_MARKER = "MATE_FACTORY_SESSION";
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export function assertSessionMarker(session: unknown): asserts session is string {
  if (typeof session !== "string" || !SESSION_ID.test(session)) {
    throw new FactoryError("the attach session id is not valid");
  }
}
const STOP_SECONDS = "10";

export class WorksetRuntime {
  private readonly run: CommandRunner;
  private readonly exists: (file: string) => boolean;
  private readonly realpath: (file: string) => string;
  private readonly listDir: (dir: string) => string[];
  private ready = false;

  constructor(private readonly options: RuntimeOptions) {
    this.run = options.run ?? runCommand;
    this.exists = options.exists ?? fs.existsSync;
    this.realpath = options.realpath ?? fs.realpathSync;
    this.listDir = options.listDir ?? ((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []));
  }

  private repoDir(repository: string): string {
    return path.join(this.options.stateDir, "repos", repoKey(repository));
  }

  worktree(id: string): string {
    return path.join(this.options.stateDir, "worktrees", id);
  }

  private docker(args: string[], env?: Record<string, string>): Promise<CommandResult> {
    return this.run("docker", args, { env: { DOCKER_HOST: this.options.dockerHost, ...env } });
  }

  private git(args: string[]): Promise<CommandResult> {
    // `ext::` would run a command named by the remote URL.
    return this.run("git", ["-c", "protocol.ext.allow=never", ...args], {
      asUser: this.options.user,
    });
  }

  private async must(result: Promise<CommandResult>, what: string): Promise<CommandResult> {
    const done = await result;
    if (done.status !== 0) {
      throw new FactoryError(`${what} failed: ${(done.stderr || done.stdout).trim()}`);
    }
    return done;
  }

  /** Factory mode is the inner daemon answering with Sysbox registered. */
  async assertAvailable(): Promise<void> {
    if (this.ready) return;
    const socket = this.options.dockerHost.replace(/^unix:\/\//, "");
    if (!this.exists(socket)) {
      throw new FactoryError(
        "the Workset runtime needs factory mode: the inner Docker daemon is not running",
      );
    }
    const info = await this.docker(["info", "--format", "{{json .Runtimes}}"]);
    if (info.status !== 0) {
      throw new FactoryError(
        `the Workset runtime needs factory mode: the inner Docker daemon does not answer (${info.stderr.trim()})`,
      );
    }
    if (!info.stdout.includes(`"${SYSBOX_RUNTIME}"`)) {
      throw new FactoryError(
        `the Workset runtime needs factory mode: the inner Docker daemon has no ${SYSBOX_RUNTIME} runtime`,
      );
    }
    this.ready = true;
  }

  /** `running`, `paused` (stopped), or null when no container exists. */
  private async containerState(id: string): Promise<"running" | "paused" | null> {
    const inspect = await this.docker([
      "container",
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName(id),
    ]);
    if (inspect.status !== 0) return null;
    return inspect.stdout.trim() === "true" ? "running" : "paused";
  }

  private assertCompanion(companion: unknown): string {
    if (typeof companion !== "string" || !path.isAbsolute(companion)) {
      throw new FactoryError(`the Session Companion must be an absolute path`);
    }
    let resolved: string;
    let root: string;
    try {
      resolved = this.realpath(companion);
      root = this.realpath(this.options.companionsDir);
    } catch {
      throw new FactoryError(`the Session Companion ${companion} does not exist`);
    }
    if (resolved !== companion || !resolved.startsWith(`${root}${path.sep}`)) {
      throw new FactoryError(
        `the Session Companion ${companion} is not a companion under ${this.options.companionsDir}`,
      );
    }
    if (!this.exists(path.join(resolved, ".mate", "config", "framework.yaml"))) {
      throw new FactoryError(`${companion} is not a Companion Repository`);
    }
    return resolved;
  }

  async spawn(request: SpawnRequest): Promise<WorksetInfo> {
    assertWorksetId(request.id);
    assertRepository(request.repository);
    if (typeof request.remoteUrl !== "string" || request.remoteUrl.startsWith("-")) {
      throw new FactoryError("the Working Repository needs a remote URL");
    }
    const companion = this.assertCompanion(request.companion);
    await this.assertAvailable();

    const repoDir = this.repoDir(request.repository);
    const worktree = this.worktree(request.id);
    const branch = deliveryBranch(request.id);

    if (!this.exists(path.join(repoDir, ".git"))) {
      await this.must(
        this.git(["clone", "--", request.remoteUrl, repoDir]),
        `cloning ${request.repository}`,
      );
    } else {
      await this.must(
        this.git(["-C", repoDir, "fetch", "--prune", "origin"]),
        `fetching ${request.repository}`,
      );
    }

    if (!this.exists(path.join(worktree, ".git"))) {
      const local = await this.git([
        "-C",
        repoDir,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      const remote = await this.git([
        "-C",
        repoDir,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${branch}`,
      ]);
      const add =
        local.status === 0
          ? ["worktree", "add", worktree, branch]
          : remote.status === 0
            ? ["worktree", "add", "--track", "-b", branch, worktree, `origin/${branch}`]
            : ["worktree", "add", "--no-track", "-b", branch, worktree, "origin/HEAD"];
      await this.must(this.git(["-C", repoDir, ...add]), `creating the worktree for ${request.id}`);
    }

    const state = await this.containerState(request.id);
    if (state === null) {
      const gitDir = path.join(repoDir, ".git");
      await this.must(
        this.docker([
          "create",
          "--name",
          containerName(request.id),
          "--hostname",
          request.id,
          "--runtime",
          SYSBOX_RUNTIME,
          "--label",
          `${LABEL_WORKSET}=${request.id}`,
          "--label",
          `${LABEL_REPOSITORY}=${request.repository}`,
          // Identical paths: a worktree's .git file names its gitdir absolutely.
          "--volume",
          `${worktree}:${worktree}`,
          "--volume",
          `${gitDir}:${gitDir}`,
          "--volume",
          `${companion}:${companion}`,
          "--workdir",
          worktree,
          this.options.image,
        ]),
        `creating the container for ${request.id}`,
      );
    }
    if (state !== "running") {
      await this.must(this.docker(["start", containerName(request.id)]), `starting ${request.id}`);
    }
    return { id: request.id, repository: request.repository, branch, state: "running" };
  }

  async pause(id: string): Promise<void> {
    assertWorksetId(id);
    await this.assertAvailable();
    const state = await this.containerState(id);
    if (state === null) throw new FactoryError(`Workset ${id} has no container`);
    if (state === "running") {
      await this.must(
        this.docker(["stop", "--time", STOP_SECONDS, containerName(id)]),
        `pausing ${id}`,
      );
    }
  }

  async resume(id: string): Promise<void> {
    assertWorksetId(id);
    await this.assertAvailable();
    const state = await this.containerState(id);
    if (state === null) throw new FactoryError(`Workset ${id} has no container; spawn it`);
    if (state === "paused") {
      await this.must(this.docker(["start", containerName(id)]), `resuming ${id}`);
    }
  }

  async exec(request: ExecRequest): Promise<CommandResult> {
    assertWorksetId(request.id);
    if (
      !Array.isArray(request.command) ||
      request.command.length === 0 ||
      !request.command.every((part) => typeof part === "string")
    ) {
      throw new FactoryError("exec needs a command as a list of strings");
    }
    const worktree = this.worktree(request.id);
    const cwd = path.resolve(worktree, request.cwd ?? ".");
    if (cwd !== worktree && !cwd.startsWith(`${worktree}${path.sep}`)) {
      throw new FactoryError(`exec's working directory ${request.cwd} is outside the worktree`);
    }
    const env = request.env ?? {};
    for (const name of Object.keys(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new FactoryError(
          `exec's environment variable name ${JSON.stringify(name)} is invalid`,
        );
      }
    }
    await this.assertAvailable();
    const state = await this.containerState(request.id);
    if (state === null) throw new FactoryError(`Workset ${request.id} has no container`);
    if (state === "paused") {
      throw new FactoryError(`Workset ${request.id} is paused; resume it first`);
    }
    // `-e NAME` takes the value from the docker client's environment, so no
    // value appears in an argument list or in the container's configuration.
    return this.run(
      "docker",
      [
        "exec",
        ...(request.stdin ? ["--interactive"] : []),
        "--user",
        this.options.user,
        "--workdir",
        cwd,
        ...Object.keys(env).flatMap((name) => ["--env", name]),
        containerName(request.id),
        ...request.command,
      ],
      { env: { ...this.dockerEnv(), ...env }, ...(request.stdin ? { stdin: request.stdin } : {}) },
    );
  }

  /** The Workset container's address on the inner Docker network, reachable from the appliance. */
  async address(id: string): Promise<string> {
    assertWorksetId(id);
    await this.assertAvailable();
    if ((await this.containerState(id)) !== "running") {
      throw new FactoryError(`Workset ${id} is not running`);
    }
    const inspect = await this.must(
      this.docker([
        "container",
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
        containerName(id),
      ]),
      `reading ${id}'s address`,
    );
    const address = inspect.stdout.trim().split(/\s+/).find(Boolean);
    if (!address) throw new FactoryError(`Workset ${id} has no network address`);
    return address;
  }

  /** The environment a `docker` client needs to reach the inner daemon. */
  dockerEnv(): Record<string, string> {
    return { DOCKER_HOST: this.options.dockerHost };
  }

  /**
   * The interactive `docker exec` for an attach, run by the broker in its own PTY. Values
   * of `envNames` and the session marker come from that client's environment, never argv.
   */
  async attachCommand(request: {
    id: string;
    command: string[];
    session: string;
    envNames: string[];
    /** False for a long-running process without a terminal, such as the harness bridge. */
    tty?: boolean;
  }): Promise<string[]> {
    assertWorksetId(request.id);
    assertSessionMarker(request.session);
    if (
      !Array.isArray(request.command) ||
      request.command.length === 0 ||
      !request.command.every((part) => typeof part === "string")
    ) {
      throw new FactoryError("attach needs a command as a list of strings");
    }
    await this.assertAvailable();
    const state = await this.containerState(request.id);
    if (state === null) throw new FactoryError(`Workset ${request.id} has no container`);
    if (state === "paused") {
      throw new FactoryError(`Workset ${request.id} is paused; resume it first`);
    }
    return [
      "docker",
      "exec",
      "--interactive",
      ...(request.tty === false ? [] : ["--tty"]),
      "--user",
      this.options.user,
      "--workdir",
      this.worktree(request.id),
      "--env",
      SESSION_MARKER,
      ...request.envNames.flatMap((name) => ["--env", name]),
      containerName(request.id),
      ...request.command,
    ];
  }

  /**
   * Stops every process inside the container that carries the session marker — the agent
   * and everything it started — leaving the container and its `dockerd` running.
   */
  async stopMarked(id: string, session: string): Promise<void> {
    assertWorksetId(id);
    assertSessionMarker(session);
    if ((await this.containerState(id)) !== "running") return;
    await this.docker(["exec", containerName(id), "mate-workset-stop", session]);
  }

  async list(): Promise<WorksetInfo[]> {
    await this.assertAvailable();
    const ps = await this.must(
      this.docker([
        "ps",
        "--all",
        "--filter",
        `label=${LABEL_WORKSET}`,
        "--format",
        `{{.Label "${LABEL_WORKSET}"}}\t{{.Label "${LABEL_REPOSITORY}"}}\t{{.State}}`,
      ]),
      "listing Workset containers",
    );
    const worksets = new Map<string, WorksetInfo>();
    for (const line of ps.stdout.split("\n")) {
      const [id, repository, state] = line.split("\t");
      if (!id) continue;
      worksets.set(id, {
        id,
        repository: repository || null,
        branch: deliveryBranch(id),
        state: state === "running" ? "running" : "paused",
      });
    }
    for (const id of this.listDir(path.join(this.options.stateDir, "worktrees"))) {
      if (worksets.has(id)) continue;
      worksets.set(id, {
        id,
        repository: this.worktreeRepository(id),
        branch: deliveryBranch(id),
        state: "missing",
      });
    }
    return [...worksets.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  /** The repository a worktree belongs to, from the clone its `.git` file points into. */
  private worktreeRepository(id: string): string | null {
    try {
      const pointer = fs.readFileSync(path.join(this.worktree(id), ".git"), "utf8");
      const key = /repos\/([^/]+)\/\.git\/worktrees\//.exec(pointer)?.[1];
      return key ? repositoryFromKey(key) : null;
    } catch {
      return null;
    }
  }

  async delete(id: string, options: { force?: boolean } = {}): Promise<void> {
    assertWorksetId(id);
    await this.assertAvailable();
    const worktree = this.worktree(id);
    const hasWorktree = this.exists(path.join(worktree, ".git"));

    if (hasWorktree && !options.force) {
      const status = await this.must(
        this.git(["-C", worktree, "status", "--porcelain"]),
        `reading ${id}'s worktree`,
      );
      const unpushed = await this.must(
        this.git(["-C", worktree, "rev-list", "--count", "HEAD", "--not", "--remotes=origin"]),
        `reading ${id}'s unpushed commits`,
      );
      const problems = [
        status.stdout.trim() !== "" ? "uncommitted changes" : null,
        Number(unpushed.stdout.trim()) > 0 ? `${unpushed.stdout.trim()} unpushed commit(s)` : null,
      ].filter(Boolean);
      if (problems.length > 0) {
        throw new FactoryError(
          `Workset ${id} has ${problems.join(" and ")}; push them or delete with force`,
        );
      }
    }

    if ((await this.containerState(id)) !== null) {
      await this.must(
        this.docker(["rm", "--force", containerName(id)]),
        `removing ${id}'s container`,
      );
    }
    if (hasWorktree) {
      const repoDir = path.dirname(
        path.dirname(
          path.dirname(
            fs
              .readFileSync(path.join(worktree, ".git"), "utf8")
              .replace(/^gitdir:\s*/, "")
              .trim(),
          ),
        ),
      );
      // The local and remote branches stay: only the checkout and its container go.
      await this.must(
        this.git(["-C", repoDir, "worktree", "remove", "--force", worktree]),
        `removing ${id}'s worktree`,
      );
    }
  }
}
