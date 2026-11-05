import { useCallback, useSyncExternalStore } from "react";

/** Whether a media query matches; false while the server renders. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (change: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", change);
      return () => list.removeEventListener("change", change);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
