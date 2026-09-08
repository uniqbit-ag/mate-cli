/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
import { Warnings } from "../warnings";
import { Changes } from "./changes";

interface DashboardProps {
  payload: StudioCompanionPayload;
}

/** Changes only: specs have their own view, and skills belong to the Workflow view. */
export function Dashboard({ payload }: DashboardProps) {
  return (
    <>
      <Changes changes={payload.changes} />
      <Warnings warnings={payload.warnings} />
    </>
  );
}
