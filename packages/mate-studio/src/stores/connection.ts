import type { QueryClient } from "@tanstack/react-query";
import {
  probeStudio,
  type StudioConnection,
  type StudioConnectionState,
} from "@uniqbit/mate-core/studio";
import { create } from "zustand";

/** The page's connection state, for Studio's own components. */
export const useConnectionState = create<{ state: StudioConnectionState }>(() => ({
  state: "online",
}));

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ConnectionMonitorOptions {
  queryClient: QueryClient;
  probe?: () => Promise<StudioConnectionState>;
  /** Fires `online` and `visibilitychange`; the browser's window outside tests. */
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  isVisible?: () => boolean;
  timers?: Timers;
}

export interface ConnectionMonitor extends StudioConnection {
  dispose(): void;
}

const browserTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Tracks the page's connection: a suspected failure starts a probe and only the probe's result
 * changes the state. While not online it probes again with backoff; on recovery it refetches
 * every query before telling subscribers.
 */
export function createConnectionMonitor({
  queryClient,
  probe = () => probeStudio(),
  target = window,
  isVisible = () => document.visibilityState === "visible",
  timers = browserTimers,
}: ConnectionMonitorOptions): ConnectionMonitor {
  const listeners = new Set<(state: StudioConnectionState) => void>();
  let probing = false;
  let retry: unknown = null;
  let delay = FIRST_RETRY_MS;
  let disposed = false;

  const settle = (next: StudioConnectionState) => {
    if (disposed) return;
    const changed = next !== useConnectionState.getState().state;
    if (next === "online") {
      delay = FIRST_RETRY_MS;
    } else {
      retry = timers.set(() => {
        retry = null;
        void run();
      }, delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
    if (!changed) return;
    useConnectionState.setState({ state: next });
    if (next === "online") void queryClient.invalidateQueries();
    for (const listener of listeners) {
      // A plugin view's listener that throws must not keep the state from the others.
      try {
        listener(next);
      } catch (error) {
        console.error(error);
      }
    }
  };

  const run = async () => {
    if (probing || disposed) return;
    if (retry !== null) {
      timers.clear(retry);
      retry = null;
    }
    probing = true;
    let next: StudioConnectionState;
    try {
      next = await probe();
    } catch {
      next = "offline";
    } finally {
      probing = false;
    }
    settle(next);
  };

  const now = () => void run();
  const onVisible = () => {
    if (isVisible()) now();
  };
  target.addEventListener("online", now);
  target.addEventListener("visibilitychange", onVisible);

  return {
    state: () => useConnectionState.getState().state,
    suspect() {
      // A scheduled retry already owns probing; more failures must not undo the backoff.
      if (retry !== null) return;
      now();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (retry !== null) timers.clear(retry);
      target.removeEventListener("online", now);
      target.removeEventListener("visibilitychange", onVisible);
      listeners.clear();
    },
  };
}

let current: ConnectionMonitor | null = null;

/** Starts the page's one monitor; browser only, so SSR never touches `window`. */
export function startConnectionMonitor(options: ConnectionMonitorOptions): ConnectionMonitor {
  current?.dispose();
  current = createConnectionMonitor(options);
  return current;
}

/** The page's monitor; `null` during SSR and before the router started it. */
export function studioConnection(): ConnectionMonitor | null {
  return current;
}
