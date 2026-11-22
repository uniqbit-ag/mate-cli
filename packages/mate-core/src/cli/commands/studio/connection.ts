/**
 * The page's connection to Studio's server. Browser-safe: plugin view bundles import it,
 * so it imports nothing from Node.
 */
import { STUDIO_PING_ROUTE } from "./routes";

export type StudioConnectionState =
  | "online"
  | "offline"
  | "signed-out"
  | "expired"
  | "host-refused";

/** A connection problem; any other state of a request is an answer of Studio's. */
export type StudioConnectionProblem = Exclude<StudioConnectionState, "online">;

/**
 * The connection problem a request's outcome (its response, or what it threw) shows.
 * `null` for any answer Studio itself gave, a refusal included, and for an abort.
 */
export function connectionStateOf(outcome: unknown): StudioConnectionProblem | null {
  if (outcome instanceof TypeError) return "offline";
  if (!(outcome instanceof Response)) return null;
  // A redirect `redirect: "manual"` stopped: an auth proxy in front of Studio.
  if (outcome.type === "opaqueredirect") return "signed-out";
  if (outcome.status === 401) return "expired";
  if (outcome.status === 421) return "host-refused";
  return null;
}

/** Pings Studio. Never carries the token, so the token exchange's 303 cannot answer it. */
export async function probeStudio(fetchImpl: typeof fetch = fetch): Promise<StudioConnectionState> {
  let outcome: unknown;
  try {
    outcome = await fetchImpl(STUDIO_PING_ROUTE, {
      redirect: "manual",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (error) {
    outcome = error;
  }
  return connectionStateOf(outcome) ?? "online";
}

/** Studio's connection state, shared with the plugin views it mounts. */
export interface StudioConnection {
  state(): StudioConnectionState;
  /** A request failed; Studio probes unless a probe is running. Only the probe changes the state. */
  suspect(): void;
  /** Calls `listener` with each new state; returns the unsubscribe. */
  subscribe(listener: (state: StudioConnectionState) => void): () => void;
}
