import type { StudioConnectionState } from "@uniqbit/mate-core/studio";

import { Button } from "../components/ui/button";
import { useConnectionState } from "../stores/connection";

const MESSAGES: Record<Exclude<StudioConnectionState, "online">, string> = {
  offline: "Connection to Studio lost",
  "signed-out": "Connection to Studio lost — reload to sign in again",
  expired: "Session expired — open the address Studio printed when it started",
  "host-refused": "Studio does not answer to this host",
};

const reloadPage = () => location.reload();

/**
 * Above the view while the page has lost Studio; the view and its data stay. Reloading is the
 * person's choice, so an unsaved edit is never lost to it.
 */
export function ConnectionBanner({ reload = reloadPage }: { reload?: () => void }) {
  const state = useConnectionState((current) => current.state);
  // The live region stays mounted, so a screen reader announces the text when it appears.
  return (
    <div role="status" aria-live="polite">
      {state === "online" ? null : (
        <div className="mx-8 mt-3 flex items-center gap-3 rounded-card border border-warn bg-warn-soft px-4 py-2.5 text-sm max-sm:mx-4">
          <span className="flex-1">{MESSAGES[state]}</span>
          {state === "host-refused" ? null : (
            <Button size="sm" onClick={reload}>
              Reload
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
