/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
import { Warnings } from "../warnings";
import { DeliveryPathView } from "./delivery-path";

interface WorkflowProps {
  payload: StudioCompanionPayload;
}

export function Workflow({ payload }: WorkflowProps) {
  return (
    <>
      <div className="workflow-view">
        <DeliveryPathView payload={payload} />
      </div>
      <Warnings warnings={payload.warnings} />
    </>
  );
}
