import fs from "node:fs";
import path from "node:path";
import { newBranchBase, resolveDeliveryBranch, worktreeAddArgs } from "../delivery/resolve-branch";
import { resolveWorksetBranch } from "../workset/record";

import { type CommandResult, type CommandRunner, runCommand } from "./command";
import { KeyedSerial } from "./keyed-serial";
import { readWorktreeBranch } from "./worktree-branch";
import {
  assertRepository,
  assertWorksetId,
  BUN_CACHE_VOLUME,
  containerName,
  deliveryBranch,
  FactoryError,
  homeVolume,
  LABEL_REPOSITORY,
  LABEL_WORKSET,
  repoKey,
  repositoryFromKey,
} from "./ids";

/**
 * The Workset runtime: one unprivileged Sysbox container per Workset, with its
 * own worktree on `workset/<workset>`, driven through the inner Docker daemon.
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
  /** The memory size the next stage needs; `build` when absent. */
  size?: MemorySize;
}

/** Agent stages run at the agent memory limit; builds and sessions at the full one. */
export type MemorySize = "agent" | "build";

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

/** Each Workset container's limits; memory includes swap. */
export interface WorksetLimits {
  /** A Docker size such as `4g`: the build size. */
  memory: string;
  /** The agent size; `memory` when absent. */
  agentMemory?: string;
  pids: number;
  /** Null sets no CPU limit. */
  cpus: string | null;
}

export interface RuntimeOptions {
  dockerHost: string;
  stateDir: string;
  image: string;
  /** The unprivileged user Git and Workset commands run as. */
  user: string;
  /** Companions must resolve inside this directory. */
  companionsDir: string;
  /** Unset leaves containers unlimited. */
  limits?: WorksetLimits;
  /** How many Workset containers may run at once; unset caps nothing. */
  maxWorksets?: number;
  /** Minutes without activity before `sweepIdle` stops a container; 0 or unset never. */
  idleMinutes?: number;
  now?: () => number;
  run?: CommandRunner;
  exists?: (file: string) => boolean;
  realpath?: (file: string) => string;
  listDir?: (dir: string) => string[];
  /** Where the inner daemon's container cgroups live; default `/sys/fs/cgroup`. */
  cgroupRoot?: string;
  writeFile?: (file: string, data: string) => void;
}

const SYSBOX_RUNTIME = "sysbox-runc";
/** The soft memory limit's share of the hard one. */
const SOFT_MEMORY_SHARE = 0.9;
const SIZE_UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** Bytes in a Docker size such as `4g` or `512m`; null when it is not one. */
export function dockerSizeBytes(size: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec(size.trim());
  if (!match) return null;
  return Math.floor(Number(match[1]) * SIZE_UNITS[(match[2] ?? "b").toLowerCase()]!);
}

/** Set on every process an attach starts in a Workset container, so a stop finds them all. */
export const SESSION_MARKER = "MATE_FACTORY_SESSION";
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export function assertSessionMarker(session: unknown): asserts session is string {
  if (typeof session !== "string" || !SESSION_ID.test(session)) {
    throw new FactoryError("the attach session id is not valid");
  }
}
const STOP_SECONDS = "10";
/**
 * How long after its last activity a container is safe from making room: an AFK turn
 * spawns its container, then attaches its bridge a moment later.
 */
export const ROOM_GRACE_MS = 60_000;
const HOME = "/home/mate";
const BUN_CACHE = "/var/cache/bun";

/** What uses a Workset container now; idle means neither. */
interface Activity {
  sessions: number;
  commands: number;
  lastActivity: number;
}

function assertCommand(command: unknown, verb: string): asserts command is string[] {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string")
  ) {
    throw new FactoryError(`${verb} needs a command as a list of strings`);
  }
}

export class WorksetRuntime {
  private readonly run: CommandRunner;
  private readonly exists: (file: string) => boolean;
  private readonly realpath: (file: string) => string;
  private readonly listDir: (dir: string) => string[];
  private readonly cgroupRoot: string;
  private readonly writeFile: (file: string, data: string) => void;
  private ready = false;
  private readonly now: () => number;
  /** In memory: after a broker restart every container's idle clock starts at the restart. */
  private readonly activity = new Map<string, Activity>();
  private readonly startedAt: number;
  /** Operations on one Workset run in order, so an idle stop cannot race a start. */
  private readonly chains = new KeyedSerial();
  /** Counting running containers and starting one happen together. */
  private capacity: Promise<unknown> = Promise.resolve();
  /** Each running container's memory size; unknown after a broker restart until read. */
  private readonly sizes = new Map<string, MemorySize>();

  constructor(private readonly options: RuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.run = options.run ?? runCommand;
    this.exists = options.exists ?? fs.existsSync;
    this.realpath = options.realpath ?? fs.realpathSync;
    this.listDir = options.listDir ?? ((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []));
    this.cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
    this.writeFile = options.writeFile ?? ((file, data) => fs.writeFileSync(file, data));
  }

  private activityOf(id: string): Activity {
    let entry = this.activity.get(id);
    if (!entry) {
      entry = { sessions: 0, commands: 0, lastActivity: this.startedAt };
      this.activity.set(id, entry);
    }
    return entry;
  }

  private touch(id: string): void {
    this.activityOf(id).lastActivity = this.now();
  }

  /** No attached session and no command in progress. */
  isIdle(id: string): boolean {
    const entry = this.activityOf(id);
    return entry.sessions === 0 && entry.commands === 0;
  }

  /** Counts an attach session from now until the returned function is called. */
  beginSession(id: string): () => void {
    return this.track(id, "sessions");
  }

  private track(id: string, kind: "sessions" | "commands"): () => void {
    const entry = this.activityOf(id);
    entry[kind] += 1;
    entry.lastActivity = this.now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      entry[kind] -= 1;
      entry.lastActivity = this.now();
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.capacity.then(operation, operation);
    this.capacity = next.catch(() => {});
    return next;
  }

  private repoDir(repository: string): string {
    return path.join(this.options.stateDir, "repos", repoKey(repository));
  }

  worktree(id: string): string {
    return path.join(this.options.stateDir, "worktrees", id);
  }

  private docker(args: string[], env?: Record<string, string>): Promise<CommandResult> {
    return this.run("docker", args, { env: { ...this.dockerEnv(), ...env } });
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
    if (request.size !== undefined && request.size !== "agent" && request.size !== "build") {
      throw new FactoryError("the memory size must be agent or build");
    }
    const companion = this.assertCompanion(request.companion);
    await this.assertAvailable();
    return this.chains.run(request.id, () => this.spawnNow(request, companion));
  }

  private async spawnNow(request: SpawnRequest, companion: string): Promise<WorksetInfo> {
    const worktree = this.worktree(request.id);
    const existing = this.exists(path.join(worktree, ".git"));
    const existingBranch = existing
      ? await readWorktreeBranch(worktree, (args) => this.git(args))
      : null;
    if (!existing) {
      const resolution = await resolveWorksetBranch(companion, request.id, request.repository);
      if (resolution.id === null) throw new FactoryError(resolution.diagnostics.join("\n"));
    }
    // A refusal for lack of room changes nothing, not even the worktree.
    if ((await this.containerState(request.id)) !== "running")
      await this.makeRoom(request.id, true);

    const repoDir = this.repoDir(request.repository);

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

    const branch =
      existingBranch ?? (await this.createWorktree(request, companion, repoDir, worktree));

    const size = request.size ?? "build";
    let state = await this.containerState(request.id);
    let migrateHome: string | null = null;
    if (state !== null && (state !== "running" || this.isIdle(request.id))) {
      const stale = await this.staleContainer(request.id);
      if (stale !== null) {
        migrateHome = stale.hasHomeVolume ? null : await this.saveHome(request.id);
        await this.must(
          this.docker(["rm", "--force", containerName(request.id)]),
          `removing ${request.id}'s container from an earlier Workset image`,
        );
        state = null;
      }
    }
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
          ...this.limitArgs(size),
          // Identical paths: a worktree's .git file names its gitdir absolutely.
          "--volume",
          `${worktree}:${worktree}`,
          "--volume",
          `${gitDir}:${gitDir}`,
          "--volume",
          `${companion}:${companion}`,
          // Named volumes: Docker seeds an empty one from the image's directory.
          "--volume",
          `${homeVolume(request.id)}:${HOME}`,
          "--volume",
          `${BUN_CACHE_VOLUME}:${BUN_CACHE}`,
          "--workdir",
          worktree,
          this.options.image,
        ]),
        `creating the container for ${request.id}`,
      );
      if (migrateHome !== null) await this.restoreHome(request.id, migrateHome);
    }
    if (state === "running") await this.resize(request.id, size);
    else await this.start(request.id, state === "paused", size);
    if (migrateHome !== null) {
      // Copied files keep the uid Sysbox stored them under, which reads as root inside.
      await this.must(
        this.docker([
          "exec",
          containerName(request.id),
          "chown",
          "-R",
          `${this.options.user}:${this.options.user}`,
          HOME,
        ]),
        `giving ${request.id}'s moved home back to ${this.options.user}`,
      );
    }
    this.touch(request.id);
    return { id: request.id, repository: request.repository, branch, state: "running" };
  }

  /** Puts a new worktree on the resolved Delivery Branch; call after fetching `repoDir`. */
  private async createWorktree(
    request: SpawnRequest,
    companion: string,
    repoDir: string,
    worktree: string,
  ): Promise<string> {
    const hasRef = async (ref: string) =>
      (await this.git(["-C", repoDir, "rev-parse", "--verify", "--quiet", ref])).status === 0;
    const resolution = await resolveDeliveryBranch({
      companionPath: companion,
      repository: request.repository,
      hasRef,
      worksetId: request.id,
    });
    const { branch, source } = resolution;
    if (branch === null || source === null) {
      throw new FactoryError(resolution.diagnostics.join("\n"));
    }
    const base = source === "new" ? await newBranchBase(hasRef) : undefined;
    await this.must(
      this.git(["-C", repoDir, ...worktreeAddArgs({ branch, source }, worktree, base)]),
      `creating the worktree for ${request.id}`,
    );
    return branch;
  }

  private memoryOf(size: MemorySize): string | undefined {
    const limits = this.options.limits;
    return size === "agent" ? (limits?.agentMemory ?? limits?.memory) : limits?.memory;
  }

  private limitArgs(size: MemorySize): string[] {
    const limits = this.options.limits;
    if (!limits) return [];
    const memory = this.memoryOf(size)!;
    return [
      "--memory",
      memory,
      // Equal to the memory limit: no swap on top of it.
      "--memory-swap",
      memory,
      "--pids-limit",
      String(limits.pids),
      ...(limits.cpus ? ["--cpus", limits.cpus] : []),
    ];
  }

  /** Starts a stopped container within the running-container cap, at the current limits. */
  private async start(id: string, existing: boolean, size: MemorySize = "build"): Promise<void> {
    await this.exclusive(async () => {
      await this.makeRoom(id);
      if (existing && this.options.limits) {
        await this.must(
          this.docker(["update", ...this.limitArgs(size), containerName(id)]),
          `updating ${id}'s limits`,
        );
      }
      await this.must(this.docker(["start", containerName(id)]), `starting ${id}`);
    });
    this.sizes.set(id, size);
    await this.setSoftMemoryLimit(id, size);
  }

  /**
   * Brings a running container to the size its next stage needs. It grows at once, and
   * shrinks only while no session or command uses it: lowering the limit under a person's
   * build makes the kernel reclaim, and may kill. A failed update is logged.
   */
  private async resize(id: string, size: MemorySize): Promise<void> {
    const wanted = this.memoryOf(size);
    if (wanted === undefined) return;
    const current = await this.currentSize(id);
    if (current === size) return;
    const wantedBytes = dockerSizeBytes(wanted);
    const currentBytes = current === null ? null : dockerSizeBytes(this.memoryOf(current)!);
    if (wantedBytes !== null && currentBytes !== null) {
      if (wantedBytes === currentBytes) {
        this.sizes.set(id, size);
        return;
      }
      if (wantedBytes < currentBytes && !this.isIdle(id)) return;
    }
    const update = await this.docker(["update", ...this.limitArgs(size), containerName(id)]);
    if (update.status !== 0) {
      process.stderr.write(
        `mate factory: Workset ${id} keeps its memory limit: ${(update.stderr || update.stdout).trim()}\n`,
      );
      return;
    }
    this.sizes.set(id, size);
    await this.setSoftMemoryLimit(id, size);
  }

  /** The running container's size, read from Docker when this broker has not set it. */
  private async currentSize(id: string): Promise<MemorySize | null> {
    const known = this.sizes.get(id);
    if (known) return known;
    const inspect = await this.docker([
      "container",
      "inspect",
      "--format",
      "{{.HostConfig.Memory}}",
      containerName(id),
    ]);
    if (inspect.status !== 0) return null;
    const bytes = Number(inspect.stdout.trim());
    for (const size of ["build", "agent"] as const) {
      const memory = this.memoryOf(size);
      if (memory !== undefined && dockerSizeBytes(memory) === bytes) {
        this.sizes.set(id, size);
        return size;
      }
    }
    return null;
  }

  /**
   * Sets `memory.high` below the hard limit, so the kernel reclaims and
   * throttles before it kills. Docker sets none, and the cgroup is new on each
   * start. A failure is logged; the container runs without it.
   */
  private async setSoftMemoryLimit(id: string, size: MemorySize): Promise<void> {
    const memory = this.memoryOf(size);
    if (memory === undefined) return;
    try {
      const bytes = dockerSizeBytes(memory);
      if (bytes === null) throw new Error(`${memory} is not a Docker size`);
      const inspect = await this.must(
        this.docker(["container", "inspect", "--format", "{{.Id}}", containerName(id)]),
        `reading ${id}'s container id`,
      );
      this.writeFile(
        path.join(this.cgroupRoot, "docker", inspect.stdout.trim(), "memory.high"),
        String(Math.floor(bytes * SOFT_MEMORY_SHARE)),
      );
    } catch (error) {
      process.stderr.write(
        `mate factory: Workset ${id} runs without a soft memory limit: ${(error as Error).message}\n`,
      );
    }
  }

  /** Workset ids of the running containers. */
  private async runningIds(): Promise<string[]> {
    const ps = await this.must(
      this.docker([
        "ps",
        "--filter",
        `label=${LABEL_WORKSET}`,
        "--filter",
        "status=running",
        "--format",
        `{{.Label "${LABEL_WORKSET}"}}`,
      ]),
      "listing running Workset containers",
    );
    return ps.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Stops the least recently active idle containers until `id` fits under the
   * cap; `check` only refuses when it could not, stopping nothing. Runs under the
   * capacity lock, so a container with an operation pending is never waited on: that
   * operation may itself wait for the lock.
   */
  private async makeRoom(id: string, check = false): Promise<void> {
    const cap = this.options.maxWorksets;
    if (cap === undefined) return;
    const others = (await this.runningIds()).filter((other) => other !== id);
    const excess = others.length - cap + 1;
    if (excess <= 0) return;
    const idle = others
      .filter(
        (other) =>
          this.isIdle(other) &&
          !this.chains.has(other) &&
          this.now() - this.activityOf(other).lastActivity >= ROOM_GRACE_MS,
      )
      .toSorted((a, b) => this.activityOf(a).lastActivity - this.activityOf(b).lastActivity);
    if (idle.length < excess) {
      throw new FactoryError(
        `all ${others.length - idle.length} running Workset containers are busy; at most ${cap} run at once (MATE_FACTORY_MAX_WORKSETS)`,
        "busy",
      );
    }
    if (check) return;
    for (const other of idle.slice(0, excess)) {
      // oxlint-disable-next-line no-await-in-loop -- stopped one by one, oldest first
      await this.chains.run(other, () => this.stopNow(other, "making room for another Workset"));
    }
  }

  /**
   * Prunes the nested daemon's dangling images and build cache, then stops the
   * container. The prune skips a daemon that never started rather than start it.
   */
  private async stopNow(id: string, why: string): Promise<boolean> {
    if (!this.isIdle(id) || (await this.containerState(id)) !== "running") return false;
    await this.docker(["exec", containerName(id), "mate-workset-prune"]);
    if (!this.isIdle(id)) return false;
    await this.must(
      this.docker(["stop", "--time", STOP_SECONDS, containerName(id)]),
      `stopping ${id} (${why})`,
    );
    return true;
  }

  /**
   * Stops every running container idle for the configured minutes; returns the
   * Workset ids it stopped. The broker calls it once a minute.
   */
  async sweepIdle(): Promise<string[]> {
    const minutes = this.options.idleMinutes ?? 0;
    if (minutes <= 0) return [];
    await this.assertAvailable();
    const cutoff = this.now() - minutes * 60_000;
    const stopped: string[] = [];
    for (const id of await this.runningIds()) {
      if (!this.isIdle(id) || this.activityOf(id).lastActivity > cutoff) continue;
      // oxlint-disable-next-line no-await-in-loop -- one stop at a time keeps the daemon calm
      const done = await this.chains.run(id, async () => {
        if (this.activityOf(id).lastActivity > cutoff) return false;
        return this.stopNow(id, "idle");
      });
      if (done) stopped.push(id);
    }
    return stopped;
  }

  /** A container made from another image than the current one, and whether it mounts its home volume. */
  private async staleContainer(id: string): Promise<{ hasHomeVolume: boolean } | null> {
    const container = await this.must(
      this.docker([
        "container",
        "inspect",
        "--format",
        "{{.Image}}\t{{range .Mounts}}{{.Name}} {{end}}",
        containerName(id),
      ]),
      `reading ${id}'s container`,
    );
    const image = await this.must(
      this.docker(["image", "inspect", "--format", "{{.Id}}", this.options.image]),
      `reading the Workset image ${this.options.image}`,
    );
    const [imageId = "", mounts = ""] = container.stdout.trim().split("\t");
    if (imageId === image.stdout.trim()) return null;
    return { hasHomeVolume: mounts.split(/\s+/).includes(homeVolume(id)) };
  }

  private homeStage(id: string): string {
    return path.join(this.options.stateDir, "home-migration", id);
  }

  /** Copies a pre-volume container's home out of it, with ownership kept. */
  private async saveHome(id: string): Promise<string> {
    const stage = this.homeStage(id);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    await this.must(
      this.docker(["cp", "--archive", `${containerName(id)}:${HOME}`, stage]),
      `saving ${id}'s home`,
    );
    return path.join(stage, path.basename(HOME));
  }

  private async restoreHome(id: string, saved: string): Promise<void> {
    await this.must(
      this.docker(["cp", "--archive", `${saved}/.`, `${containerName(id)}:${HOME}`]),
      `moving ${id}'s home to its volume`,
    );
    fs.rmSync(this.homeStage(id), { recursive: true, force: true });
  }

  async pause(id: string): Promise<void> {
    assertWorksetId(id);
    await this.assertAvailable();
    await this.chains.run(id, async () => {
      const state = await this.containerState(id);
      if (state === null) throw new FactoryError(`Workset ${id} has no container`);
      if (state === "running") {
        await this.must(
          this.docker(["stop", "--time", STOP_SECONDS, containerName(id)]),
          `pausing ${id}`,
        );
      }
    });
  }

  async resume(id: string): Promise<void> {
    assertWorksetId(id);
    await this.assertAvailable();
    await this.chains.run(id, async () => {
      const state = await this.containerState(id);
      if (state === null) throw new FactoryError(`Workset ${id} has no container; spawn it`);
      if (state === "paused") await this.start(id, true);
      this.touch(id);
    });
  }

  async exec(request: ExecRequest): Promise<CommandResult> {
    assertWorksetId(request.id);
    assertCommand(request.command, "exec");
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
    // Counted before waiting, so an idle stop queued meanwhile sees it busy.
    const done = this.track(request.id, "commands");
    try {
      await this.chains.settled(request.id);
      await this.assertStarted(request.id);
      // `-e NAME` takes the value from the docker client's environment, so no
      // value appears in an argument list or in the container's configuration.
      return await this.run(
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
        {
          env: { ...this.dockerEnv(), ...env },
          ...(request.stdin ? { stdin: request.stdin } : {}),
        },
      );
    } finally {
      done();
    }
  }

  /** Available, with the Workset's container created and not paused. */
  private async assertStarted(id: string): Promise<void> {
    await this.assertAvailable();
    const state = await this.containerState(id);
    if (state === null) throw new FactoryError(`Workset ${id} has no container`);
    if (state === "paused") {
      throw new FactoryError(`Workset ${id} is paused; resume it first`);
    }
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
    assertCommand(request.command, "attach");
    await this.assertStarted(request.id);
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
    return Promise.all(
      [...worksets.values()]
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .map(async (info) => {
          const worktree = this.worktree(info.id);
          return {
            ...info,
            branch: this.exists(path.join(worktree, ".git"))
              ? await readWorktreeBranch(worktree, (args) => this.git(args))
              : info.branch,
          };
        }),
    );
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
    await this.chains.run(id, () => this.deleteNow(id, options));
  }

  private async deleteNow(id: string, options: { force?: boolean }): Promise<void> {
    const worktree = this.worktree(id);
    const hasWorktree = this.exists(path.join(worktree, ".git"));

    if (hasWorktree && !options.force) {
      const status = await this.must(
        this.git(["-C", worktree, "status", "--porcelain"]),
        `reading ${id}'s worktree`,
      );
      const unpushed = await this.must(
        this.git(["-C", worktree, "log", "--format=%h %s", "HEAD", "--not", "--remotes=origin"]),
        `reading ${id}'s unpushed commits`,
      );
      const commits = unpushed.stdout.split("\n").filter((line) => line.trim() !== "");
      const named = commits.slice(0, 3).join("; ") + (commits.length > 3 ? "; …" : "");
      const problems = [
        status.stdout.trim() !== "" ? "uncommitted changes" : null,
        commits.length > 0 ? `${commits.length} unpushed commit(s) (${named})` : null,
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
    // Missing for a Workset whose container never ran with it.
    await this.docker(["volume", "rm", "--force", homeVolume(id)]);
    this.activity.delete(id);
  }
}
