/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
import { Warnings } from "../warnings";
import { WorkflowTranscript } from "./transcript";

interface WorkflowProps {
  payload: StudioCompanionPayload;
}

export function Workflow({ payload }: WorkflowProps) {
  return (
    <>
      <div className="workflow-view">
        <div className="workflow-eyebrow">Workflow</div>
        <WorkflowTranscript payload={payload} />
      </div>
      <Warnings warnings={payload.warnings} />
    </>
  );
}
