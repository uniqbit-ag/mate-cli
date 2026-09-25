import { randomUUID } from "node:crypto";

export const TERMINAL_AGENTS = ["claude", "opencode"] as const;
export type TerminalAgent = (typeof TERMINAL_AGENTS)[number];

export const TERMINAL_LIMITS = {
  ringBytes: 1024 * 1024,
  viewerQueueBytes: 1024 * 1024,
  inputBytes: 64 * 1024,
  cols: [2, 500] as const,
  rows: [1, 300] as const,
  sessions: 4,
  pingMs: 15_000,
  heartbeatDeadlineMs: 30_000,
  termGraceMs: 5_000,
  reapMs: 5_000,
};

export const DEFAULT_DETACH_MINUTES = { serve: 30, interactive: 2 } as const;

/**
 * Bun's PTY, reached through `globalThis` because the repository typechecks
 * against Node types only.
 */
interface BunTerminalRuntime {
  Terminal?: unknown;
  spawn(
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      terminal: {
        cols: number;
        rows: number;
        name: string;
        data: (terminal: unknown, data: Uint8Array) => void;
      };
    },
  ): {
    pid: number;
    exited: Promise<number>;
    terminal?: {
      write(data: string | Uint8Array): number;
      resize(c: number, r: number): void;
      close(): void;
    };
  };
  which(command: string): string | null;
}

function bunRuntime(): BunTerminalRuntime | undefined {
  return (globalThis as unknown as { Bun?: BunTerminalRuntime }).Bun;
}

/** `null` when this runtime can host the terminal; otherwise the requirement it misses. */
export function terminalUnsupportedReason(
  platform: NodeJS.Platform = process.platform,
  runtime: BunTerminalRuntime | undefined = bunRuntime(),
): string | null {
  if (platform === "win32") return "requires macOS or Linux; Windows has no supported terminal";
  if (!runtime || typeof runtime.Terminal !== "function") {
    return "requires Bun 1.3.5 or later, which provides a native pseudo-terminal";
  }
  return null;
}

export function agentInstalled(agent: TerminalAgent): boolean {
  return Boolean(bunRuntime()?.which(agent));
}

export interface TerminalProcess {
  pid: number;
  exited: Promise<number>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface TerminalSpawnRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void;
}

export type TerminalSpawn = (request: TerminalSpawnRequest) => TerminalProcess;

/** A PTY child is its own session and process-group leader, so `-pid` reaches its descendants. */
export const bunTerminalSpawn: TerminalSpawn = (request) => {
  const runtime = bunRuntime();
  if (!runtime) throw new Error("the terminal requires the Bun runtime");
  const child = runtime.spawn(request.argv, {
    cwd: request.cwd,
    env: request.env,
    terminal: {
      cols: request.cols,
      rows: request.rows,
      name: "xterm-256color",
      data: (_terminal, data) => request.onData(data),
    },
  });
  return {
    pid: child.pid,
    exited: child.exited,
    write: (data) => void child.terminal?.write(data),
    resize: (cols, rows) => child.terminal?.resize(cols, rows),
    close: () => child.terminal?.close(),
  };
};

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /** The group is already gone. */
  }
}

/** Keeps the newest `limit` bytes; the oldest are dropped, possibly mid-sequence. */
export class RingBuffer {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(data: Uint8Array): void {
    if (data.byteLength >= this.limit) {
      this.chunks = [data.slice(data.byteLength - this.limit)];
      this.size = this.limit;
      return;
    }
    this.chunks.push(data);
    this.size += data.byteLength;
    while (this.size > this.limit) {
      const first = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.size -= first.byteLength;
      } else {
        this.chunks[0] = first.slice(excess);
        this.size -= excess;
      }
    }
  }

  get byteLength(): number {
    return this.size;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

/** One browser connection. `bufferedAmount` is what the socket has queued but not yet sent. */
export interface TerminalViewer {
  send(data: string | Uint8Array): void;
  bufferedAmount(): number;
  ping(): void;
  close(code?: number, reason?: string): void;
}

export interface TerminalSessionInfo {
  id: string;
  agent: TerminalAgent;
  companionPath: string;
  attached: boolean;
  startedAt: number;
}

export type TerminalLaunchResolution = { companionPath: string } | { reason: string };

export interface TerminalRegistryOptions {
  detachMs: number;
  /** Validates the agent against the effective companion at launch time. */
  resolveLaunch: (
    agent: string,
    companionDigest: string | null,
  ) => Promise<TerminalLaunchResolution>;
  /** The Mate invocation prefix, e.g. `[bun, cli.mjs]`. */
  mateCommand: string[];
  noGit?: boolean;
  env?: NodeJS.ProcessEnv;
  spawn?: TerminalSpawn;
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  limits?: Partial<typeof TERMINAL_LIMITS>;
}

interface Session {
  id: string;
  agent: TerminalAgent;
  companionPath: string;
  startedAt: number;
  process: TerminalProcess;
  ring: RingBuffer;
  viewer: TerminalViewer | null;
  detachedAt: number | null;
  expiry: ReturnType<typeof setTimeout> | null;
  ending: Promise<void> | null;
  exited: boolean;
}

interface Connection {
  viewer: TerminalViewer;
  lastPong: number;
  session: Session | null;
}

export interface TerminalConnection {
  message(raw: string | Uint8Array): Promise<void>;
  pong(): void;
  closed(): void;
}

function send(viewer: TerminalViewer, message: Record<string, unknown>): void {
  try {
    viewer.send(JSON.stringify(message));
  } catch {
    /** A closing socket; its close handler detaches it. */
  }
}

function inRange(value: unknown, [min, max]: readonly [number, number]): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Every agent session one Studio server started. Sessions detach rather than
 * end when their viewer goes away, and all of them end with `stopAll`.
 */
export class TerminalRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Set<Connection>();
  private readonly limits: typeof TERMINAL_LIMITS;
  private readonly spawn: TerminalSpawn;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly now: () => number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(private readonly options: TerminalRegistryOptions) {
    this.limits = { ...TERMINAL_LIMITS, ...options.limits };
    this.spawn = options.spawn ?? bunTerminalSpawn;
    this.signal = options.signalGroup ?? signalGroup;
    this.now = options.now ?? Date.now;
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      agent: session.agent,
      companionPath: session.companionPath,
      attached: session.viewer !== null,
      startedAt: session.startedAt,
    }));
  }

  connect(viewer: TerminalViewer): TerminalConnection {
    const connection: Connection = { viewer, lastPong: this.now(), session: null };
    this.connections.add(connection);
    this.ensureHeartbeat();
    return {
      message: (raw) => this.message(connection, raw),
      pong: () => {
        connection.lastPong = this.now();
      },
      closed: () => {
        this.connections.delete(connection);
        this.detach(connection, "closed", false);
      },
    };
  }

  /** Runs one heartbeat round; exposed so tests need not wait on real timers. */
  beat(): void {
    const now = this.now();
    for (const connection of this.connections) {
      if (now - connection.lastPong > this.limits.heartbeatDeadlineMs) {
        this.connections.delete(connection);
        this.detach(connection, "heartbeat", true);
        continue;
      }
      try {
        connection.viewer.ping();
      } catch {
        /** Closed; its close handler runs. */
      }
    }
  }

  async end(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await this.finish(session, { type: "ended" });
    return true;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await Promise.all(
      [...this.sessions.values()].map((session) =>
        this.finish(session, { type: "ended", reason: "Studio stopped" }),
      ),
    );
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat || this.stopping) return;
    this.heartbeat = setInterval(() => this.beat(), this.limits.pingMs);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private async message(connection: Connection, raw: string | Uint8Array): Promise<void> {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    if (text.length > this.limits.inputBytes * 2) {
      send(connection.viewer, { type: "error", reason: "message too large" });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      send(connection.viewer, { type: "error", reason: "malformed message" });
      return;
    }
    switch (parsed.type) {
      case "start":
        return this.start(connection, parsed);
      case "attach":
        return this.attach(connection, parsed);
      case "input":
        return this.input(connection, parsed);
      case "resize":
        return this.resize(connection, parsed);
      case "end":
        if (connection.session) await this.finish(connection.session, { type: "ended" });
        return;
      default:
        send(connection.viewer, { type: "error", reason: "unknown message" });
    }
  }

  private dimensions(message: Record<string, unknown>): { cols: number; rows: number } | null {
    return inRange(message.cols, this.limits.cols) && inRange(message.rows, this.limits.rows)
      ? { cols: message.cols, rows: message.rows }
      : null;
  }

  private async start(connection: Connection, message: Record<string, unknown>): Promise<void> {
    const viewer = connection.viewer;
    if (this.stopping) return send(viewer, { type: "error", reason: "Studio is stopping" });
    if (connection.session) {
      return send(viewer, { type: "error", reason: "this connection already views a session" });
    }
    const size = this.dimensions(message);
    if (!size) return send(viewer, { type: "error", reason: "terminal size out of range" });
    if (!TERMINAL_AGENTS.includes(message.agent as TerminalAgent)) {
      return send(viewer, { type: "error", reason: "the terminal starts only claude or opencode" });
    }
    const agent = message.agent as TerminalAgent;
    const digest = typeof message.companion === "string" ? message.companion : null;
    const resolved = await this.options.resolveLaunch(agent, digest);
    if ("reason" in resolved) return send(viewer, { type: "error", reason: resolved.reason });
    if (connection.session || !this.connections.has(connection)) return;

    if (this.sessions.size >= this.limits.sessions) {
      const detached = [...this.sessions.values()]
        .filter((session) => session.viewer === null && session.ending === null)
        .toSorted((a, b) => a.detachedAt! - b.detachedAt!)[0];
      if (!detached) {
        return send(viewer, {
          type: "error",
          reason: `Studio already runs ${this.limits.sessions} attached sessions; end one first`,
        });
      }
      void this.finish(detached, { type: "ended", reason: "evicted" });
    }

    const session = this.launch(agent, resolved.companionPath, size);
    this.attachTo(connection, session, size);
  }

  private launch(
    agent: TerminalAgent,
    companionPath: string,
    size: { cols: number; rows: number },
  ): Session {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.env ?? process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.MATE_REPO_PATH;
    delete env.MATE_REPO_ID;
    delete env.MATE_STUDIO_TOKEN;
    env.MATE_ARTIFACT_PATH = companionPath;
    env.TERM = "xterm-256color";
    const argv = [
      ...this.options.mateCommand,
      agent,
      "--",
      "--companion",
      "--yes",
      ...(this.options.noGit ? ["--no-git"] : []),
    ];

    const session = {
      id: randomUUID(),
      agent,
      companionPath,
      startedAt: this.now(),
      ring: new RingBuffer(this.limits.ringBytes),
      viewer: null,
      detachedAt: null,
      expiry: null,
      ending: null,
      exited: false,
    } as Omit<Session, "process"> as Session;
    session.process = this.spawn({
      argv,
      cwd: companionPath,
      env,
      cols: size.cols,
      rows: size.rows,
      onData: (data) => this.output(session, data),
    });
    this.sessions.set(session.id, session);
    void session.process.exited.then((status) => {
      session.exited = true;
      if (!session.ending) void this.finish(session, { type: "exit", status });
    });
    return session;
  }

  private output(session: Session, data: Uint8Array): void {
    session.ring.push(data);
    const viewer = session.viewer;
    if (!viewer) return;
    try {
      viewer.send(data);
    } catch {
      return;
    }
    if (viewer.bufferedAmount() > this.limits.viewerQueueBytes) {
      const connection = [...this.connections].find((candidate) => candidate.viewer === viewer);
      if (connection) this.detach(connection, "slow", true);
    }
  }

  private attachTo(
    connection: Connection,
    session: Session,
    size: { cols: number; rows: number },
  ): void {
    if (session.viewer && session.viewer !== connection.viewer) {
      const previous = [...this.connections].find((c) => c.viewer === session.viewer);
      send(session.viewer, { type: "takenOver" });
      if (previous) previous.session = null;
      try {
        session.viewer.close(4001, "taken over");
      } catch {
        /** Already closing. */
      }
    }
    if (session.expiry) clearTimeout(session.expiry);
    session.expiry = null;
    session.detachedAt = null;
    session.viewer = connection.viewer;
    connection.session = session;

    send(connection.viewer, {
      type: "ready",
      sessionId: session.id,
      agent: session.agent,
      companionPath: session.companionPath,
    });
    const replay = session.ring.snapshot();
    if (replay.byteLength > 0) {
      try {
        connection.viewer.send(replay);
      } catch {
        /** Closed during replay. */
      }
    }
    /** Replay can start mid-sequence; a size change makes the agent's interface redraw. */
    session.process.resize(size.cols, size.rows > 1 ? size.rows - 1 : size.rows + 1);
    session.process.resize(size.cols, size.rows);
  }

  private async attach(connection: Connection, message: Record<string, unknown>): Promise<void> {
    const size = this.dimensions(message);
    if (!size)
      return send(connection.viewer, { type: "error", reason: "terminal size out of range" });
    const session =
      typeof message.sessionId === "string" ? this.sessions.get(message.sessionId) : undefined;
    if (!session || session.ending) {
      return send(connection.viewer, { type: "gone", sessionId: message.sessionId ?? null });
    }
    if (connection.session === session) return;
    if (connection.session) this.detach(connection, "switched", false);
    this.attachTo(connection, session, size);
  }

  private async input(connection: Connection, message: Record<string, unknown>): Promise<void> {
    const session = connection.session;
    if (!session || session.viewer !== connection.viewer) {
      return send(connection.viewer, { type: "error", reason: "this connection views no session" });
    }
    if (typeof message.data !== "string") return;
    if (Buffer.byteLength(message.data) > this.limits.inputBytes) {
      return send(connection.viewer, { type: "error", reason: "input too large" });
    }
    session.process.write(message.data);
  }

  private async resize(connection: Connection, message: Record<string, unknown>): Promise<void> {
    const session = connection.session;
    if (!session || session.viewer !== connection.viewer) {
      return send(connection.viewer, { type: "error", reason: "this connection views no session" });
    }
    const size = this.dimensions(message);
    if (!size)
      return send(connection.viewer, { type: "error", reason: "terminal size out of range" });
    session.process.resize(size.cols, size.rows);
  }

  private detach(connection: Connection, reason: string, close: boolean): void {
    const session = connection.session;
    connection.session = null;
    if (close) {
      send(connection.viewer, { type: "detached", reason });
      try {
        connection.viewer.close(4000, reason);
      } catch {
        /** Already closed. */
      }
    }
    if (!session || session.viewer !== connection.viewer) return;
    session.viewer = null;
    if (session.ending) return;
    session.detachedAt = this.now();
    session.expiry = setTimeout(() => {
      void this.finish(session, { type: "ended", reason: "detach window expired" });
    }, this.options.detachMs);
    (session.expiry as { unref?: () => void }).unref?.();
  }

  /** TERM the group, KILL it after the grace period, and wait for the reap. */
  private finish(session: Session, notice: Record<string, unknown>): Promise<void> {
    if (session.ending) return session.ending;
    if (session.expiry) clearTimeout(session.expiry);
    session.expiry = null;
    this.sessions.delete(session.id);
    const viewer = session.viewer;
    session.viewer = null;
    if (viewer) {
      send(viewer, notice);
      const connection = [...this.connections].find((c) => c.viewer === viewer);
      if (connection) connection.session = null;
    }
    const wait = (ms: number) =>
      Promise.race([
        session.process.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    session.ending = (async () => {
      if (!session.exited) {
        this.signal(session.process.pid, "SIGTERM");
        await wait(this.limits.termGraceMs);
      }
      /** Always: descendants may outlive a leader that honoured TERM. */
      this.signal(session.process.pid, "SIGKILL");
      await wait(this.limits.reapMs);
      try {
        session.process.close();
      } catch {
        /** Already closed. */
      }
    })();
    return session.ending;
  }
}
