import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

/** Pure session helpers: ids, terminal names, command lines, repository filter. */

export type Runtime = "claude" | "opencode";

export type SessionState = "running" | "parked" | "done";
export type SessionActivity = "working" | "idle" | "waiting";

/** One entry of `mate session list --json`. */
export interface Session {
  id: string;
  runtime: Runtime;
  origin?: "editor" | "managed" | "unmanaged";
  cwd: string;
  startedAt: string;
  lastSeenAt?: string;
  endedAt?: string;
  branch?: string;
  label?: string;
  change?: string;
  attentionAt?: string;
  state?: SessionState;
  activity?: SessionActivity;
  /** Running Claude sessions: `background` when Claude's daemon runs it. */
  kind?: "interactive" | "background";
  /** Running Claude background sessions: the id `claude attach` and `claude stop` take. */
  daemonId?: string;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * OpenCode's own id form (2.x): `ses_` + 12 hex of `~(ms * 0x1000 + counter)` + 14 base62.
 * The inverted timestamp makes newer ids sort first, as OpenCode's do.
 */
export function opencodeSessionId(now = Date.now(), random: Uint8Array = randomBytes(14)): string {
  const inverted = ~(BigInt(now) * 0x1000n + 1n);
  let hex = "";
  for (let index = 0; index < 6; index += 1) {
    hex += Number((inverted >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  return `ses_${hex}${Array.from(random, (byte) => BASE62[byte % 62]).join("")}`;
}

export function newSessionId(runtime: Runtime): string {
  return runtime === "claude" ? randomUUID() : opencodeSessionId();
}

/** Random tail of the id: OpenCode ids share their prefix for sessions started close together. */
export function shortId(id: string): string {
  return id.slice(-8);
}

const TERMINAL_NAME = /^Mate (claude|opencode) · (\S+)$/;

export function terminalName(session: Pick<Session, "id" | "runtime">): string {
  return `Mate ${session.runtime} · ${shortId(session.id)}`;
}

export function parseTerminalName(name: string): { runtime: Runtime; shortId: string } | null {
  const match = TERMINAL_NAME.exec(name);
  return match ? { runtime: match[1] as Runtime, shortId: match[2]! } : null;
}

export function isSessionTerminal(session: Session, name: string): boolean {
  const parsed = parseTerminalName(name);
  return parsed?.runtime === session.runtime && parsed.shortId === shortId(session.id);
}

/** OpenCode runs every sidebar session as a client of its repository's Mate OpenCode server. */
const openCodeBackground = (id: string) => `mate opencode -- --bg --session ${id}`;

export function launchCommand(session: Pick<Session, "id" | "runtime">): string {
  return session.runtime === "claude"
    ? `mate claude -- --session-id ${session.id}`
    : openCodeBackground(session.id);
}

export function resumeCommand(session: Pick<Session, "id" | "runtime">): string {
  return session.runtime === "claude"
    ? `mate claude -- --resume ${session.id}`
    : openCodeBackground(session.id);
}

/** The daemon's id as Mate listed it; it has been the first 8 characters of the session id. */
export function daemonId(session: Pick<Session, "id" | "daemonId">): string {
  return session.daemonId ?? session.id.slice(0, 8);
}

/**
 * Running in the background, so a terminal can attach to it and Stop works:
 * any running OpenCode session (a client of the Mate OpenCode server), and a
 * Claude session its daemon runs.
 */
export function attachable(session: Pick<Session, "runtime" | "state" | "kind">): boolean {
  return (
    session.state === "running" && (session.runtime === "opencode" || session.kind === "background")
  );
}

/** Connects a terminal to a running background session. */
export function attachCommand(session: Pick<Session, "id" | "runtime" | "daemonId">): string {
  return session.runtime === "claude"
    ? `claude attach ${daemonId(session)}`
    : openCodeBackground(session.id);
}

function isInside(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Sessions whose directory is the repository, one of its worktrees, or inside them. */
export function sessionsForRepository(sessions: Session[], roots: string[]): Session[] {
  return sessions.filter((session) => roots.some((root) => isInside(session.cwd, root)));
}
