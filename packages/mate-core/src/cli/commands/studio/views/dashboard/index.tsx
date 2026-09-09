/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
import { Warnings } from "../warnings";
import { Changes } from "./changes";

interface DashboardProps {
  payload: StudioCompanionPayload;
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
