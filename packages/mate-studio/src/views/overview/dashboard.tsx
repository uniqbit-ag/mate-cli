import type { StudioCompanionPayload } from "@uniqbit/mate-core/studio";
import { Warnings } from "../warnings";
import { Changes } from "./changes";

interface DashboardProps {
  payload: Pick<StudioCompanionPayload, "changes" | "warnings">;
}

/** Changes only: specs and skills have their own views. */
export function Dashboard({ payload }: DashboardProps) {
  return (
    <>
      <Changes changes={payload.changes} />
      <Warnings warnings={payload.warnings} />
    </>
  );
}
