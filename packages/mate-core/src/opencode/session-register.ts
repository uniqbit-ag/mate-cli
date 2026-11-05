import type { Context } from "@opencode/plugin/promise/plugin";

import {
  endSession,
  isEnded,
  isRegistered,
  patchSession,
  refreshSession,
  type SessionActivity,
  type SessionInput,
  type WriteOptions,
} from "../runtime/session-registry";
import { currentBranch } from "../runtime/current-branch";

/**
 * Keeps the OpenCode sessions an editor plugin registered (it does so before
 * launching them) current in the Mate session registry: on creation, on the
 * first prompt of a resumed session, on rename (label), on step and permission
 * events (activity, attention), and on deletion or plugin shutdown (end). Any
 * other session writes nothing. Every write is best-effort; a failure never
 * reaches OpenCode.
 */

export interface OpenCodeRegisterDeps {
  /** Refreshes a registered session; null when it is not registered. */
  register: (input: SessionInput) => Promise<unknown | null>;
  registered: (id: string) => Promise<boolean>;
  /** Registered and marked ended, e.g. by `mate session stop` while this server ran on. */
  ended: (id: string) => Promise<boolean>;
  label: (id: string, label: string) => Promise<unknown>;
  activity: (id: string, activity: SessionActivity, attentionAt?: string) => Promise<unknown>;
  end: (id: string) => Promise<unknown>;
  branch: (dir: string) => Promise<string | null>;
  pid: number;
  now: () => Date;
}

const ignore = (): void => {};

/** Hooks skip a write they cannot lock within 2 s. */
const PLUGIN_WRITE: WriteOptions = { lock: { waitMs: 2000 } };

export const openCodeRegisterDeps: OpenCodeRegisterDeps = {
  register: (input) => refreshSession(input, PLUGIN_WRITE),
  registered: (id) => isRegistered(id, PLUGIN_WRITE),
  ended: (id) => isEnded(id, PLUGIN_WRITE),
  label: (id, label) => patchSession(id, { label }, PLUGIN_WRITE),
  activity: (id, activity, attentionAt) =>
    patchSession(id, { activity, attentionAt }, PLUGIN_WRITE),
  end: (id) => endSession(id, PLUGIN_WRITE),
  branch: currentBranch,
  pid: process.pid,
  now: () => new Date(),
};

interface SessionEvent {
  type?: string;
  location?: { directory?: string };
  data?: {
    sessionID?: string;
    parentID?: string;
    title?: string;
    finish?: string;
    location?: { directory?: string };
  };
}

/**
 * The activity an event moves a session to. A step ending in `tool-calls` is
 * followed by the next step of the same turn, so the session stays working.
 */
function activityAfter(event: SessionEvent): SessionActivity | undefined {
  switch (event.type) {
    case "session.step.started":
    case "permission.replied":
      return "working";
    case "session.step.ended":
      return event.data?.finish === "tool-calls" ? undefined : "idle";
    case "session.step.failed":
      return "idle";
    case "permission.asked":
      return "waiting";
    default:
      return undefined;
  }
}

function eventDirectory(event: SessionEvent): string | undefined {
  return event.location?.directory ?? event.data?.location?.directory;
}

/**
 * Subscribes to session events; returns the cleanup that ends what it
 * registered, unless `keepSessions`: a Mate OpenCode server keeps them running.
 */
export async function registerOpenCodeSessions(
  api: Context,
  deps: OpenCodeRegisterDeps = openCodeRegisterDeps,
): Promise<(options?: { keepSessions?: boolean }) => Promise<void>> {
  const directory = api.location.directory;
  const seen = new Set<string>();
  const registered = new Set<string>();
  const activities = new Map<string, SessionActivity>();

  /** Writes only a change; every permission request is one (its time). */
  const track = async (id: string, event: SessionEvent) => {
    const activity = activityAfter(event);
    if (!activity) return;
    const asked = event.type === "permission.asked";
    if (!asked && activities.get(id) === activity) return;
    activities.set(id, activity);
    const attentionAt = asked ? deps.now().toISOString() : undefined;
    await deps.activity(id, activity, attentionAt).catch(ignore);
  };

  const register = async (id: string, prompted = false) => {
    if (seen.has(id)) {
      // A session stopped and resumed on this server: clear its end.
      if (!prompted || !registered.has(id)) return;
      if (!(await deps.ended(id).catch(() => false))) return;
    }
    seen.add(id);
    // Any other session costs one registry read, no Git call.
    if (!(await deps.registered(id).catch(() => false))) return;
    const branch = await deps.branch(directory).catch(() => null);
    const refreshed = await deps
      .register({
        id,
        runtime: "opencode",
        cwd: directory,
        pid: deps.pid,
        ...(branch ? { branch } : {}),
      })
      .catch(() => null);
    if (refreshed) registered.add(id);
  };

  /** A resumed session (`--session <id>`) emits no `session.created`. */
  await api.session.hook("prompt", (event) => {
    void register(event.sessionID, true);
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const raw of api.event.subscribe({ signal: controller.signal })) {
        const event = raw as SessionEvent;
        const id = event.data?.sessionID;
        if (!id) continue;
        if (event.type === "session.created") {
          if (event.data?.parentID) continue;
          if (eventDirectory(event) !== directory) continue;
          await register(id);
        } else if (event.type === "session.renamed" && registered.has(id) && event.data?.title) {
          await deps.label(id, event.data.title).catch(ignore);
        } else if (event.type === "session.deleted" && registered.has(id)) {
          registered.delete(id);
          seen.delete(id);
          activities.delete(id);
          await deps.end(id).catch(ignore);
        } else if (registered.has(id)) {
          await track(id, event);
        }
      }
    } catch {
      /* subscription closed: the location is shutting down */
    }
  })();

  return async ({ keepSessions = false } = {}) => {
    controller.abort();
    if (!keepSessions) await Promise.all([...registered].map((id) => deps.end(id).catch(ignore)));
    registered.clear();
    seen.clear();
  };
}
