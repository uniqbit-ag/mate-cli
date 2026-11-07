import type { OpenChange } from "./changes";
import { shortId, type Session } from "./sessions";

/** Pure grouping and labelling of sessions and open changes by Workset. */

const OLDER_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const WORKSET_PREFIX = "workset/";

export interface Workset {
  /** Delivery Branch, or the change name for a change without one. */
  key: string;
  label: string;
  branch?: string;
  changes: OpenChange[];
}

export type SessionGroupKind = "workset" | "branch" | "default" | "older" | "none";

export interface SessionGroup {
  kind: SessionGroupKind;
  label: string;
  description?: string;
  sessions: Session[];
}

export function worksetLabel(branch: string): string {
  return branch.startsWith(WORKSET_PREFIX) ? branch.slice(WORKSET_PREFIX.length) : branch;
}

/** Changes sharing a Delivery Branch form one Workset; a change without one is its own. */
export function worksetsOf(changes: OpenChange[]): Workset[] {
  const byKey = new Map<string, Workset>();
  for (const change of changes) {
    const key = change.deliveryBranch ?? change.name;
    let workset = byKey.get(key);
    if (!workset) {
      workset = change.deliveryBranch
        ? { key, label: worksetLabel(key), branch: key, changes: [] }
        : { key, label: change.name, changes: [] };
      byKey.set(key, workset);
    }
    workset.changes.push(change);
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- engines.vscode 1.85 runs Node 18, which lacks toSorted
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function worksetProgress(workset: Workset): string {
  const { done, total } = workset.changes.reduce(
    (sum, change) => ({ done: sum.done + change.done, total: sum.total + change.total }),
    { done: 0, total: 0 },
  );
  return `${done}/${total} tasks`;
}

function seenAt(session: Session): number {
  return Date.parse(session.lastSeenAt ?? session.startedAt) || 0;
}

/** Running first, then newest `lastSeenAt`. */
function bySessionOrder(running: (session: Session) => boolean) {
  return (a: Session, b: Session) =>
    Number(running(b)) - Number(running(a)) || seenAt(b) - seenAt(a);
}

/**
 * Workset groups, then other branches, then the default branch, then `Older`
 * (parked outside a Workset, last seen over 14 days ago). Sessions without a
 * branch share an unlabelled group before `Older`. An umbrella passes every child's
 * default branch.
 */
export function groupSessions(
  sessions: Session[],
  worksets: Workset[],
  defaultBranch: string | ReadonlySet<string>,
  running: (session: Session) => boolean,
  now: Date = new Date(),
): SessionGroup[] {
  const defaults: ReadonlySet<string> =
    typeof defaultBranch === "string" ? new Set([defaultBranch]) : defaultBranch;
  const worksetByBranch = new Map(
    worksets.filter((workset) => workset.branch).map((workset) => [workset.branch!, workset]),
  );
  const groups = new Map<string, SessionGroup>();
  const older: Session[] = [];
  const add = (key: string, kind: SessionGroupKind, label: string, session: Session) => {
    let group = groups.get(key);
    if (!group) {
      group = {
        kind,
        label,
        description: kind === "workset" ? session.branch : undefined,
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  };

  for (const session of sessions) {
    const workset = session.branch ? worksetByBranch.get(session.branch) : undefined;
    if (workset) {
      add(`w:${workset.key}`, "workset", workset.label, session);
      continue;
    }
    if (!running(session) && now.getTime() - seenAt(session) > OLDER_AFTER_MS) {
      older.push(session);
      continue;
    }
    if (!session.branch) add("none", "none", "No branch", session);
    else if (defaults.has(session.branch)) {
      add(`d:${session.branch}`, "default", session.branch, session);
    } else add(`b:${session.branch}`, "branch", session.branch, session);
  }
  if (older.length > 0) groups.set("older", { kind: "older", label: "Older", sessions: older });

  const rank: Record<SessionGroupKind, number> = {
    workset: 0,
    branch: 1,
    default: 2,
    none: 3,
    older: 4,
  };
  const order = bySessionOrder(running);
  // oxlint-disable unicorn/no-array-sort -- engines.vscode 1.85 runs Node 18, which lacks toSorted
  for (const group of groups.values()) group.sessions.sort(order);
  return [...groups.values()].sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label),
  );
  // oxlint-enable unicorn/no-array-sort
}

/** The change, else the Workset's only open change, else the first prompt, else the short id. */
export function sessionLabel(session: Session, worksets: Workset[]): string {
  if (session.change) return session.change;
  const workset = session.branch
    ? worksets.find((entry) => entry.branch === session.branch)
    : undefined;
  if (workset?.changes.length === 1) return workset.changes[0]!.name;
  const prompt = session.label?.replace(/\s+/g, " ").trim();
  if (prompt) return prompt;
  return shortId(session.id);
}

/** Sessions running on a Workset's Delivery Branch. */
export function worksetSessions(workset: Workset, sessions: Session[]): Session[] {
  return workset.branch ? sessions.filter((session) => session.branch === workset.branch) : [];
}

/** The most recently seen session, or undefined. */
export function latestSession(sessions: Session[]): Session | undefined {
  let latest: Session | undefined;
  for (const session of sessions) if (!latest || seenAt(session) > seenAt(latest)) latest = session;
  return latest;
}
