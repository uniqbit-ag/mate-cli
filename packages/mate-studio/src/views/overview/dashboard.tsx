import type { StudioCompanionPayload } from "@uniqbit/mate-core/studio";
import { Warnings } from "../warnings";
import { Changes } from "./changes";

interface DashboardProps {
  payload: Pick<StudioCompanionPayload, "changes" | "warnings" | "submitted"> &
    Partial<Pick<StudioCompanionPayload, "workflow">>;
  /** The change whose panel is open, from the address. */
  selected?: string;
  /** The selected companion, for reading a change's artifacts. */
  companion?: string;
}

/** Changes only: specs and skills have their own views. */
export function Dashboard({ payload, selected, companion }: DashboardProps) {
  return (
    <>
      <Warnings warnings={payload.warnings} />
      <Changes
        changes={payload.changes}
        submitted={payload.submitted}
        selected={selected}
        companion={companion}
        // An invalid declaration places changes on the default path.
        workflow={payload.workflow ?? undefined}
      />
    </>
  );
}
