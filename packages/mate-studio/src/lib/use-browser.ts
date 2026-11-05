import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * `true` once the page runs in the browser. Queries the shell starts only for counts wait for
 * it, so the server-rendered document never holds its stream open for them.
 */
export function useBrowser(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
