import { formatCollectedAt } from "@uniqbit/mate-core/studio";
import { useSyncExternalStore } from "react";

// The formatted time never changes for a given moment, so nothing is subscribed to.
const subscribe = () => () => {};

/**
 * A moment in the viewer's own time zone. The shell is rendered on the server, whose zone may
 * differ (the factory appliance runs in UTC), so the time is filled in after the page hydrates.
 */
export function LocalTime({ at }: { at: number }) {
  const text = useSyncExternalStore(
    subscribe,
    () => formatCollectedAt(at),
    () => "",
  );
  return <time dateTime={new Date(at).toISOString()}>{text}</time>;
}
