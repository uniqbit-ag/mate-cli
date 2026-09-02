/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
import { Warnings } from "../warnings";
import { Changes } from "./changes";
import { Specs } from "./specs";

interface DashboardProps {
  payload: StudioCompanionPayload;
}

/** Changes and specs only: skills belong to the Workflow view. */
export function Dashboard({ payload }: DashboardProps) {
  return (
    <>
      <Changes changes={payload.changes} />
      <Specs specs={payload.specs} />
      <Warnings warnings={payload.warnings} />
    </>
  );
}
