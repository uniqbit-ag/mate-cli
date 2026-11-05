import type { StudioCompanionPayload } from "@uniqbit/mate-core/studio";
import { Warnings } from "../warnings";
import { Changes } from "./changes";

interface DashboardProps {
  payload: Pick<StudioCompanionPayload, "changes" | "warnings">;
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
      <Changes changes={payload.changes} selected={selected} companion={companion} />
    </>
  );
}
