import {
  defaultWorkflow,
  type StudioChange,
  type StudioCompanionPayload,
  type Workflow as DeliveryWorkflow,
} from "@uniqbit/mate-core/studio";

import { changePath, changeStep } from "../overview/change-group";
import { Warnings } from "../warnings";
import { DeliveryPathView, type StageChanges, type StageCounts } from "./delivery-path";
import { reviewNode } from "./steps";

interface WorkflowProps {
  payload: Pick<StudioCompanionPayload, "skills" | "topology" | "warnings"> &
    Partial<Pick<StudioCompanionPayload, "workflow">>;
  /** The companion's active changes, placed on the graph at the stage the Overview names. */
  changes?: StudioChange[];
}

const DEFAULT_WORKFLOW = defaultWorkflow();

/** The changes at each stage a change can be at, in path order, as the Overview places them. */
function stagesOf(
  changes: StudioChange[],
  workflow: DeliveryWorkflow,
): {
  counts: StageCounts;
  byStage: StageChanges[];
} {
  const at = changes.map((change) => ({
    name: change.name,
    stage: changeStep(change, workflow).stageId,
  }));
  const byStage: StageChanges[] = changePath(workflow).map((stage) => ({
    node: stage.kind === "review" ? reviewNode(stage.id) : stage.id,
    label: stage.label,
    changes: at.flatMap((change) => (change.stage === stage.id ? [change.name] : [])),
  }));
  const counts: StageCounts = {};
  for (const stage of byStage)
    if (stage.changes.length > 0) counts[stage.node] = stage.changes.length;
  return { counts, byStage };
}

const NO_CHANGES: StudioChange[] = [];

export function Workflow({ payload, changes = NO_CHANGES }: WorkflowProps) {
  // An invalid declaration draws the default path; the warning above names its problems.
  const { counts, byStage } = stagesOf(changes, payload.workflow ?? DEFAULT_WORKFLOW);
  return (
    <>
      <Warnings warnings={payload.warnings} />
      <div className="workflow-view">
        <DeliveryPathView payload={payload} counts={counts} changesByStage={byStage} />
      </div>
    </>
  );
}
